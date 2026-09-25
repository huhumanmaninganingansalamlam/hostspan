import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OAuthService } from "../auth/oauth-service.js";
import type { HostSpanConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { defaultConfigPath, oauthApprovalSecretPath } from "../config/paths.js";
import { fileList } from "../files/list.js";
import { cleanupTerminalPatchJournals, FilePatchService, recoverPatchTransactions } from "../files/patch.js";
import { resolveTargetPath } from "../targets/path.js";
import { fileRead } from "../files/read.js";
import { fileSearch } from "../files/search.js";
import { ripgrepExecutable } from "../files/ripgrep.js";
import { asHostSpanError } from "../errors.js";
import { TOOL_NAMES, TOOLSET_HASH, type HostSpanToolAuthorization, type HostSpanToolHandlers } from "../mcp/registry.js";
import type {
  FileListToolInput,
  FilePatchToolInput,
  FileReadToolInput,
  FileSearchToolInput,
  ProcessCancelToolInput,
  ProcessPollToolInput,
  ProcessStartToolInput,
  ProcessWriteToolInput,
  SystemStatusInput,
  TargetListInput,
} from "../tools/schemas.js";
import { auditErrorDiagnostics } from "../observability/error-diagnostics.js";
import { HostSpanLogger } from "../observability/logger.js";
import { PolicyEvaluator } from "../policy/evaluator.js";
import { protectWindowsFile, protectWindowsTree } from "../security/windows-acl.js";
import { isQualifiedCorePlatform } from "../platform.js";
import { cleanupExpiredProcessSpools } from "../processes/output-spool.js";
import type { InteractiveSessionManager } from "../processes/interactive-session.js";
import { PtySessionManager } from "../processes/pty-session.js";
import { recoverProcesses } from "../processes/recovery.js";
import { ProcessSupervisor } from "../processes/supervisor.js";
import { AuditRepo } from "../state/audit-repo.js";
import {
  claimRuntimeGeneration,
  databaseResponsive,
  openDatabase,
  syncTargetSnapshots,
  type HostSpanDatabase,
} from "../state/database.js";
import { argumentHash, OperationsRepo } from "../state/operations-repo.js";
import { OAuthRepo } from "../state/oauth-repo.js";
import { ProcessesRepo } from "../state/processes-repo.js";
import { TransactionsRepo } from "../state/transactions-repo.js";
import { targetConfigDigest, TargetRegistry } from "../targets/registry.js";
import { PROTOCOL_VERSION, SERVER_VERSION, TOOLSET_VERSION } from "../version.js";
import { BoundedConcurrencyLimiter } from "./concurrency-limiter.js";

export interface HostSpanRuntime {
  config: HostSpanConfig;
  configPath: string;
  db: HostSpanDatabase;
  targets: TargetRegistry;
  policy: PolicyEvaluator;
  operations: OperationsRepo;
  processes: ProcessesRepo;
  transactions: TransactionsRepo;
  audit: AuditRepo;
  logger: HostSpanLogger;
  supervisor: ProcessSupervisor;
  terminal?: InteractiveSessionManager;
  searchLimiter: BoundedConcurrencyLimiter;
  searchBackendReady(): boolean;
  terminalBackendReady(): boolean;
  oauthRepo: OAuthRepo;
  oauth?: OAuthService;
  handlers: HostSpanToolHandlers;
  authorization: HostSpanToolAuthorization;
  activate(): void;
  close(): Promise<void>;
}

export function runtimeReadiness(runtime: HostSpanRuntime) {
  let databaseReady = false;
  try {
    databaseReady = databaseResponsive(runtime.db);
  } catch {
    databaseReady = false;
  }
  const processReady = isQualifiedCorePlatform();
  const searchReady = runtime.searchBackendReady();
  const terminalReady = runtime.config.terminal ? runtime.terminalBackendReady() : true;
  return {
    ready: databaseReady && processReady,
    degraded: !searchReady || !terminalReady,
    toolset_hash: TOOLSET_HASH,
    policy_epoch: runtime.config.policy_epoch,
    backends: {
      database: databaseReady,
      process: processReady,
      search: searchReady,
      terminal: terminalReady,
    },
  };
}

function cachedExecutableProbe(command: string, args: string[] = ["--version"], ttlMs = 5_000): () => boolean {
  let checkedAt = 0;
  let ready = false;
  return () => {
    const now = Date.now();
    if (checkedAt === 0 || now - checkedAt >= ttlMs) {
      ready = spawnSync(command, args, { stdio: "ignore", timeout: 5_000, windowsHide: true }).status === 0;
      checkedAt = now;
    }
    return ready;
  };
}

function cachedNodeModuleProbe(specifier: string, ttlMs = 5_000): () => boolean {
  const resolvedUrl = pathToFileURL(createRequire(import.meta.url).resolve(specifier)).href;
  let checkedAt = 0;
  let ready = false;
  return () => {
    const now = Date.now();
    if (checkedAt === 0 || now - checkedAt >= ttlMs) {
      const script = `import(${JSON.stringify(resolvedUrl)}).then(()=>process.exit(0)).catch(()=>process.exit(1))`;
      ready =
        ["linux", "darwin", "win32"].includes(process.platform) &&
        spawnSync(process.execPath, ["-e", script], {
          stdio: "ignore",
          timeout: 5_000,
          windowsHide: true,
          env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
        }).status === 0;
      checkedAt = now;
    }
    return ready;
  };
}

export function createRuntime(
  configPath = defaultConfigPath(),
  options: { deferActivation?: boolean } = {},
): HostSpanRuntime {
  const resolvedConfigPath = resolve(configPath);
  const config = loadConfig(resolvedConfigPath);
  protectWindowsFile(resolvedConfigPath);
  protectWindowsFile(`${resolvedConfigPath}.bak`);
  protectWindowsFile(oauthApprovalSecretPath(resolvedConfigPath));
  protectWindowsTree(config.server.data_dir);
  const targets = new TargetRegistry(config);
  const db = openDatabase(join(config.server.data_dir, "state.db"));
  const operations = new OperationsRepo(db);
  const processes = new ProcessesRepo(db);
  const transactions = new TransactionsRepo(db);
  const audit = new AuditRepo(db, {
    maxAgeDays: config.retention.audit_days,
    maxEvents: config.retention.max_audit_events ?? 500_000,
  });
  const oauthRepo = new OAuthRepo(db);
  const logger = new HostSpanLogger(config.server.data_dir);
  const policy = new PolicyEvaluator(config, [
    resolvedConfigPath,
    `${resolvedConfigPath}.bak`,
    oauthApprovalSecretPath(resolvedConfigPath),
  ]);
  const terminal = config.terminal
    ? new PtySessionManager(config.server.data_dir, config.terminal, { requireOwnership: true, configPath: resolvedConfigPath })
    : undefined;
  let runtimeActive = false;
  const runRetentionMaintenance = () => {
    const now = new Date().toISOString();
    const removedPatchJournals = cleanupTerminalPatchJournals(transactions);
    const cleanup = cleanupExpiredProcessSpools(
      config.server.data_dir,
      processes.expiredOutput(now).map((record) => record.process_id),
      config.retention.max_total_spool_bytes,
      processes.outputRetentionCandidates().map((record) => record.process_id),
    );
    for (const processId of cleanup.evicted) processes.expireOutput(processId, now);
    const compactedOperationResults = operations.compactResultsOlderThan(config.retention.operation_result_days);
    const prunedProcessRows = processes.pruneTerminalMetadataOlderThan(config.retention.operation_result_days);
    const prunedPatchTransactions = transactions.pruneTerminalOlderThan(config.retention.operation_result_days);
    oauthRepo.pruneExpired(Math.floor(Date.now() / 1_000));
    const auditMaintenance = audit.maintain();
    if (cleanup.over_quota) logger.info("spool.quota_exceeded", cleanup);
    if (
      removedPatchJournals.length ||
      cleanup.removed.length ||
      cleanup.evicted.length ||
      compactedOperationResults > 0 ||
      prunedProcessRows > 0 ||
      prunedPatchTransactions > 0 ||
      auditMaintenance.deleted_by_age ||
      auditMaintenance.deleted_by_cap
    ) {
      logger.info("retention.maintained", {
        patch_journals_removed: removedPatchJournals.length,
        spool_removed: cleanup.removed.length,
        spool_evicted: cleanup.evicted.length,
        spool_total_bytes: cleanup.total_bytes,
        operation_results_compacted: compactedOperationResults,
        process_rows_pruned: prunedProcessRows,
        patch_transactions_pruned: prunedPatchTransactions,
        audit_deleted_by_age: auditMaintenance.deleted_by_age,
        audit_deleted_by_cap: auditMaintenance.deleted_by_cap,
      });
    }
  };
  const maintainRetentionSafely = () => {
    if (!runtimeActive) return;
    try {
      runRetentionMaintenance();
    } catch (error) {
      logger.info("retention.maintenance_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const activate = (): void => {
    if (runtimeActive) return;
    if (terminal) terminal.activateOwnership(claimRuntimeGeneration(db));
    recoverPatchTransactions(targets, transactions);
    const removedPatchJournals = cleanupTerminalPatchJournals(transactions);
    if (removedPatchJournals.length) logger.info("patch.journals_cleaned", { count: removedPatchJournals.length });
    syncTargetSnapshots(
      db,
      targets.list().map((target) => ({
        target_id: target.target_id,
        config_digest: targetConfigDigest(config.targets[target.target_id]),
        policy_epoch: config.policy_epoch,
        provider: target.provider,
        root_fingerprint: targets.fingerprint(target),
        ready: target.ready,
      })),
    );

    const recoveredProcesses = recoverProcesses(
      processes,
      operations,
      terminal,
      config.retention.completed_process_output_ttl_minutes,
    );
    for (const recovered of recoveredProcesses) logger.info("process.recovered", recovered);
    runtimeActive = true;
    maintainRetentionSafely();
  };
  if (!options.deferActivation) activate();

  const patchService = new FilePatchService({ data_dir: config.server.data_dir, operations, transactions, policy });
  const supervisor = new ProcessSupervisor({ config, targets, policy, operations, processes, ...(terminal ? { terminal } : {}), logger });
  let closing = false;
  let processMaintenanceInflight: Promise<void> | undefined;
  let closeRuntimePromise: Promise<void> | undefined;
  const processMaintenanceTimer = setInterval(() => {
    if (closing || !runtimeActive || processMaintenanceInflight) return;
    processMaintenanceInflight = supervisor
      .reconcileInteractiveProcesses()
      .catch((error) => {
        logger.info("process.reconcile_failed", { message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        processMaintenanceInflight = undefined;
      });
  }, 500);
  processMaintenanceTimer.unref();
  const retentionMaintenanceTimer = setInterval(maintainRetentionSafely, 60_000);
  retentionMaintenanceTimer.unref();
  const searchLimiter = new BoundedConcurrencyLimiter({
    maxConcurrent: config.server.max_concurrent_searches ?? 8,
    maxQueued: config.server.max_queued_searches ?? 16,
    queueTimeoutMs: config.server.search_queue_timeout_ms ?? 1_000,
    resource: "file_search",
    label: "Search",
  });
  const searchBackendReady = cachedExecutableProbe(ripgrepExecutable());
  const terminalBackendReady = cachedNodeModuleProbe("node-pty");
  const oauth = config.oauth ? new OAuthService(config.oauth, oauthRepo) : undefined;

  const traced = async <T extends Record<string, unknown>>(
    tool: string,
    input: unknown,
    requestId: string,
    run: () => Promise<T> | T,
  ): Promise<T> => {
    const started = Date.now();
    const inputRecord = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const metadata = {
      tool,
      argument_hash: argumentHash(input),
      target_id: typeof inputRecord.target_id === "string" ? inputRecord.target_id : undefined,
    };
    audit.append({ request_id: requestId, event_type: "request.accepted", metadata });
    logger.auditEvent("request.accepted", { request_id: requestId, ...metadata });
    try {
      const result = await run();
      const idempotencyKey = typeof inputRecord.idempotency_key === "string" ? inputRecord.idempotency_key : undefined;
      const processId = typeof result.process_id === "string" ? result.process_id : undefined;
      audit.append({
        request_id: requestId,
        event_type: "response.returned",
        metadata: { tool, total_ms: Date.now() - started, state: result.state },
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        ...(processId ? { process_id: processId } : {}),
      });
      return result;
    } catch (error) {
      const known = asHostSpanError(error);
      const idempotencyKey = typeof inputRecord.idempotency_key === "string" ? inputRecord.idempotency_key : undefined;
      audit.append({
        request_id: requestId,
        event_type: "request.aborted",
        metadata: { tool, stage: "handler", ...auditErrorDiagnostics(known), total_ms: Date.now() - started },
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      });
      throw error;
    }
  };

  const handlers: HostSpanToolHandlers = {
    system_status: (_input: SystemStatusInput, requestId: string) =>
      traced("system_status", {}, requestId, () => {
        const searchReady = searchBackendReady();
        const terminalReady = config.terminal ? terminalBackendReady() : true;
        const processReady = isQualifiedCorePlatform();
        return {
          server_version: SERVER_VERSION,
          protocol_version: PROTOCOL_VERSION,
          toolset_version: TOOLSET_VERSION,
          advertised_tools: [...TOOL_NAMES],
          backends: {
            search: { name: "ripgrep", ready: searchReady },
            database: { name: "sqlite", ready: databaseResponsive(db) },
            process: {
              name: process.platform === "win32" ? "windows_process_tree" : "posix_process_group",
              ready: processReady,
            },
            terminal: { name: "hostspan_pty", ready: terminalReady, configured: Boolean(config.terminal) },
            search_concurrency: searchLimiter.snapshot(),
          },
          active_process_count: processes.activeCount(),
          degraded: !searchReady || !terminalReady,
          oauth: oauth
            ? { enabled: true, issuer: oauth.issuer, resource: oauth.publicMcpUrl }
            : { enabled: false },
          native_execution: true,
          sandboxed: false,
        };
      }),
    target_list: (_input: TargetListInput, requestId: string) =>
      traced("target_list", {}, requestId, () => ({
        targets: targets.list().map((target) => ({
          target_id: target.target_id,
          label: target.label,
          provider: target.provider,
          capabilities: target.capabilities,
          exec_mode: target.exec_profile ? "native" : null,
          ready: target.ready,
        })),
      })),
    file_list: (input: FileListToolInput, requestId: string) =>
      traced("file_list", input, requestId, () => {
        const target = targets.get(input.target_id, "read");
        return fileList(target, input, policy);
      }),
    file_read: (input: FileReadToolInput, requestId: string) =>
      traced("file_read", input, requestId, () => {
        const target = targets.get(input.target_id, "read");
        const guarded = resolveTargetPath(target, input.path);
        policy.assertFileAllowed(target, guarded.relative, guarded.absolute, false);
        return fileRead(target, input);
      }),
    file_search: (input: FileSearchToolInput, requestId: string) =>
      traced("file_search", input, requestId, () =>
        searchLimiter.run(async () => {
          const target = targets.get(input.target_id, "read");
          for (const path of input.paths.length ? input.paths : ["."]) {
            const guarded = resolveTargetPath(target, path);
            policy.assertFileAllowed(target, guarded.relative, guarded.absolute, false);
          }
          return fileSearch(target, input);
        }),
      ),
    file_patch: (input: FilePatchToolInput, requestId: string) =>
      traced("file_patch", input, requestId, () => patchService.apply(targets.get(input.target_id, "write"), input)),
    process_start: (input: ProcessStartToolInput, requestId: string) =>
      traced("process_start", input, requestId, () => supervisor.start(input, requestId)),
    process_poll: (input: ProcessPollToolInput, requestId: string) =>
      traced("process_poll", input, requestId, () => supervisor.poll(input)),
    process_write: (input: ProcessWriteToolInput, requestId: string) =>
      traced("process_write", input, requestId, () => supervisor.write(input)),
    process_cancel: (input: ProcessCancelToolInput, requestId: string) =>
      traced("process_cancel", input, requestId, () => supervisor.cancel(input)),
  };

  const authorization: HostSpanToolAuthorization = {
    processBackend: (processId) => {
      const backend = processes.get(processId)?.backend;
      return backend === "native" || backend === "pty" ? backend : undefined;
    },
  };

  return {
    config,
    configPath: resolvedConfigPath,
    db,
    targets,
    policy,
    operations,
    processes,
    transactions,
    audit,
    logger,
    supervisor,
    ...(terminal ? { terminal } : {}),
    searchLimiter,
    searchBackendReady,
    terminalBackendReady,
    oauthRepo,
    ...(oauth ? { oauth } : {}),
    handlers,
    authorization,
    activate,
    close: () => {
      if (closeRuntimePromise) return closeRuntimePromise;
      closing = true;
      clearInterval(processMaintenanceTimer);
      clearInterval(retentionMaintenanceTimer);
      closeRuntimePromise = (async () => {
        await processMaintenanceInflight;
        await supervisor.settleForRuntimeClose();
        if (db.open) db.close();
      })();
      return closeRuntimePromise;
    },
  };
}
