#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOAuthSetup, OAuthService, rotateOAuthApprovalSecret } from "../auth/oauth-service.js";
import { addLocalWorkspace, buildAdminSnapshot, removeLocalWorkspace, resolveTerminalSession } from "../admin/snapshot.js";
import type { HostSpanConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { defaultConfigPath } from "../config/paths.js";
import { createInitialConfig } from "../config/defaults.js";
import { writeConfigAtomic } from "../config/writer.js";
import { fileList } from "../files/list.js";
import { cleanupTerminalPatchJournals, FilePatchService, recoverPatchTransactions } from "../files/patch.js";
import { resolveTargetPath } from "../files/path-guard.js";
import { fileRead } from "../files/read.js";
import { fileSearch, SearchConcurrencyLimiter } from "../files/search.js";
import { ripgrepExecutable } from "../files/ripgrep.js";
import { asHostSpanError, HostSpanError } from "../mcp/errors.js";
import { TOOL_NAMES, TOOLSET_HASH, toolsetDocument, type HostSpanToolAuthorization, type HostSpanToolHandlers } from "../mcp/registry.js";
import { createHostSpanHttpServer, listenHostSpan } from "../mcp/server.js";
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
} from "../mcp/schemas.js";
import { auditErrorDiagnostics } from "../observability/error-diagnostics.js";
import { HostSpanLogger } from "../observability/logger.js";
import { buildSupportExport, writeSupportExportAtomic } from "../observability/support-export.js";
import { PolicyEvaluator } from "../policy/evaluator.js";
import { protectWindowsFile, protectWindowsTree } from "../security/windows-acl.js";
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
  openMemoryDatabase,
  openReadOnlyDatabase,
  syncTargetSnapshots,
  type HostSpanDatabase,
} from "../state/database.js";
import { argumentHash, OperationsRepo } from "../state/operations-repo.js";
import { OAuthRepo } from "../state/oauth-repo.js";
import { ProcessesRepo } from "../state/processes-repo.js";
import { TransactionsRepo } from "../state/transactions-repo.js";
import { TargetRegistry } from "../targets/registry.js";
import { PROTOCOL_VERSION, SERVER_VERSION, TOOLSET_VERSION } from "../version.js";
import { runDoctor } from "./doctor.js";
import { daemonStatus, removeDaemonPid, startDaemon, startDaemonControlServer, stopDaemon, writeDaemonPid } from "./daemon.js";
import { installSystemdService, runServiceCommand } from "./service.js";
import { runSmoke } from "./smoke.js";

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
  searchLimiter: SearchConcurrencyLimiter;
  searchBackendReady(): boolean;
  terminalBackendReady(): boolean;
  oauthRepo: OAuthRepo;
  oauth?: OAuthService;
  handlers: HostSpanToolHandlers;
  authorization: HostSpanToolAuthorization;
  activateSessionOwnership(): number | null;
  close(): Promise<void>;
}

export function runtimeReadiness(runtime: HostSpanRuntime) {
  let databaseReady = false;
  try {
    databaseReady = databaseResponsive(runtime.db);
  } catch {
    databaseReady = false;
  }
  const processReady =
    ((process.platform === "linux" || process.platform === "win32") && process.arch === "x64") ||
    (process.platform === "darwin" && (process.arch === "x64" || process.arch === "arm64"));
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

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function cliValidationError(message: string, details: Record<string, unknown> = {}): HostSpanError {
  return new HostSpanError("VALIDATION_FAILED", message, false, details);
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

function oauthApprovalSecretPath(configPath: string): string {
  return join(dirname(configPath), "oauth-approval-secret");
}

function writeOAuthApprovalSecret(configPath: string, secret: string): string {
  const path = oauthApprovalSecretPath(configPath);
  const dir = dirname(path);
  const temp = `${path}.tmp-${process.pid}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temp, `${secret}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    protectWindowsFile(temp);
    renameSync(temp, path);
    chmodSync(path, 0o600);
    protectWindowsFile(path);
  } finally {
    rmSync(temp, { force: true });
  }
  return path;
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase());
}

export function createRuntime(
  configPath = defaultConfigPath(),
  options: { deferSessionOwnership?: boolean } = {},
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
  syncTargetSnapshots(db, config, targets);
  recoverPatchTransactions(targets, transactions);
  const removedPatchJournals = cleanupTerminalPatchJournals(transactions);
  if (removedPatchJournals.length) logger.info("patch.journals_cleaned", { count: removedPatchJournals.length });
  const terminal = config.terminal
    ? new PtySessionManager(config.server.data_dir, config.terminal, { requireOwnership: true, configPath: resolvedConfigPath })
    : undefined;
  let sessionOwnershipActive = !terminal;
  let runtimeGeneration: number | null = null;
  const activateSessionOwnership = (): number | null => {
    if (!terminal) return null;
    if (sessionOwnershipActive) return runtimeGeneration;
    const generation = claimRuntimeGeneration(db);
    terminal.activateOwnership(generation);
    runtimeGeneration = generation;
    const recoveredProcesses = recoverProcesses(
      processes,
      operations,
      terminal,
      config.retention.completed_process_output_ttl_minutes,
    );
    for (const recovered of recoveredProcesses) logger.info("process.recovered", recovered);
    sessionOwnershipActive = true;
    return generation;
  };
  if (!options.deferSessionOwnership) activateSessionOwnership();
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
    try {
      runRetentionMaintenance();
    } catch (error) {
      logger.info("retention.maintenance_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  maintainRetentionSafely();

  const patchService = new FilePatchService({ data_dir: config.server.data_dir, operations, transactions, policy });
  const supervisor = new ProcessSupervisor({ config, targets, policy, operations, processes, ...(terminal ? { terminal } : {}), logger });
  let closing = false;
  let processMaintenanceInflight = Promise.resolve();
  let closeRuntimePromise: Promise<void> | undefined;
  const processMaintenanceTimer = setInterval(() => {
    if (closing || !sessionOwnershipActive) return;
    processMaintenanceInflight = processMaintenanceInflight
      .then(async () => {
        if (closing || !sessionOwnershipActive) return;
        await supervisor.reconcileInteractiveProcesses();
      })
      .catch((error) => {
        logger.info("process.reconcile_failed", { message: error instanceof Error ? error.message : String(error) });
      });
  }, 500);
  processMaintenanceTimer.unref();
  const retentionMaintenanceTimer = setInterval(maintainRetentionSafely, 60_000);
  retentionMaintenanceTimer.unref();
  const searchLimiter = new SearchConcurrencyLimiter(
    config.server.max_concurrent_searches ?? 8,
    config.server.max_queued_searches ?? 16,
    config.server.search_queue_timeout_ms ?? 1_000,
  );
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
              ready:
                ((process.platform === "linux" || process.platform === "win32") && process.arch === "x64") ||
                (process.platform === "darwin" && (process.arch === "x64" || process.arch === "arm64")),
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
        const guarded = resolveTargetPath(target, input.path, "read");
        policy.assertFileAllowed(target, guarded.relative, guarded.absolute, false);
        return fileRead(target, input);
      }),
    file_search: (input: FileSearchToolInput, requestId: string) =>
      traced("file_search", input, requestId, () =>
        searchLimiter.run(async () => {
          const target = targets.get(input.target_id, "read");
          for (const path of input.paths.length ? input.paths : ["."]) {
            const guarded = resolveTargetPath(target, path, "search");
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
    activateSessionOwnership,
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

function usage(): string {
  return `HostSpan ${SERVER_VERSION}\n\nCommands:\n  init [--config PATH]\n  serve [--config PATH]\n  daemon start|stop|status [--config PATH]\n  doctor [--config PATH]\n  smoke --target TARGET [--config PATH]\n  status [--verbose] [--config PATH]\n  admin snapshot [--recent N] [--config PATH]\n  terminal list|attach --process PROCESS_ID [--read-only] [--config PATH]\n  targets list|add|remove ... [--config PATH]\n  oauth init --public-url https://host/mcp [--config PATH]\n  oauth status [--config PATH]\n  oauth rotate-secret [--config PATH]\n  policy validate [--config PATH]\n  print-toolset\n  logs [--follow] [--config PATH]\n  support-export [PATH] [--config PATH]\n  service install|start|stop|restart|status [--config PATH]\n  --version\n`;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return 0;
  }
  if (command === "--version" || command === "version") {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return 0;
  }
  if (command === "print-toolset") {
    print({ toolset_hash: TOOLSET_HASH, ...toolsetDocument() });
    return 0;
  }

  const configPath = resolve(flag(argv, "--config") ?? defaultConfigPath());
  if (command === "daemon") {
    const action = argv[1];
    if (action === "start") {
      print(await startDaemon(configPath));
      return 0;
    }
    if (action === "stop") {
      print(await stopDaemon(configPath));
      return 0;
    }
    if (action === "status") {
      print(daemonStatus(configPath));
      return 0;
    }
    throw cliValidationError("daemon requires start, stop, or status");
  }
  if (command === "init") {
    if (existsSync(configPath)) throw cliValidationError(`config already exists: ${configPath}`);
    writeConfigAtomic(configPath, createInitialConfig());
    print({ ok: true, config_path: configPath, next: "hostspan targets add --id <target> --root <absolute-path>" });
    return 0;
  }
  if (command === "doctor") {
    const report = await runDoctor(configPath);
    print(report);
    return report.ok ? 0 : 1;
  }
  if (command === "oauth") {
    const action = argv[1];
    const config = loadConfig(configPath);
    if (action === "init") {
      if (config.oauth) throw cliValidationError("OAuth is already configured. Use hostspan oauth rotate-secret to rotate credentials.");
      const publicUrl = flag(argv, "--public-url");
      if (!publicUrl) throw cliValidationError("oauth init requires --public-url https://host/mcp");
      const setup = createOAuthSetup(publicUrl);
      const hostname = new URL(setup.config.public_mcp_url).hostname;
      const allowedHosts = new Set(config.server.allowed_hosts ?? []);
      allowedHosts.add(hostname);
      config.server.allowed_hosts = [...allowedHosts];
      config.oauth = setup.config;
      config.policy_epoch += 1;
      writeConfigAtomic(configPath, config);
      const approvalSecretFile = writeOAuthApprovalSecret(configPath, setup.approval_secret);
      print({
        ok: true,
        public_mcp_url: setup.config.public_mcp_url,
        issuer: new URL(`${new URL(setup.config.public_mcp_url).origin}/`).href,
        approval_secret_file: approvalSecretFile,
        warning: "The OAuth approval secret is stored only in the local mode-0600 file. Do not copy it into logs or chat messages.",
      });
      return 0;
    }
    if (action === "status") {
      print({
        enabled: Boolean(config.oauth),
        ...(config.oauth
          ? {
              public_mcp_url: config.oauth.public_mcp_url,
              issuer: new URL(`${new URL(config.oauth.public_mcp_url).origin}/`).href,
              approval_secret_file: oauthApprovalSecretPath(configPath),
              access_token_ttl_minutes: config.oauth.access_token_ttl_minutes,
              refresh_token_ttl_days: config.oauth.refresh_token_ttl_days,
            }
          : {}),
      });
      return 0;
    }
    if (action === "rotate-secret") {
      if (!config.oauth) throw cliValidationError("OAuth is not configured. Run hostspan oauth init first.");
      const rotated = rotateOAuthApprovalSecret(config.oauth);
      config.oauth = rotated.config;
      config.policy_epoch += 1;
      writeConfigAtomic(configPath, config);
      const approvalSecretFile = writeOAuthApprovalSecret(configPath, rotated.approval_secret);
      const db = openDatabase(join(config.server.data_dir, "state.db"));
      try {
        new OAuthRepo(db).revokeAll(Math.floor(Date.now() / 1000));
      } finally {
        db.close();
      }
      print({
        ok: true,
        approval_secret_file: approvalSecretFile,
        tokens_revoked: true,
        warning: "The new OAuth approval secret is stored only in the local mode-0600 file. Existing access and refresh tokens were revoked.",
      });
      return 0;
    }
    throw cliValidationError("oauth requires init, status, or rotate-secret");
  }
  if (command === "serve") {
    const existingDaemon = daemonStatus(configPath);
    if (existingDaemon.running && existingDaemon.pid !== process.pid) {
      throw cliValidationError(`HostSpan is already running with pid ${existingDaemon.pid}.`);
    }
    const runtime = createRuntime(configPath, { deferSessionOwnership: true });
    if (!isLoopbackHost(runtime.config.server.listen_host) && !runtime.oauth) {
      await runtime.close();
      throw cliValidationError("Non-loopback listen_host requires OAuth. Run hostspan oauth init --public-url https://<host>/mcp first.");
    }
    const app = createHostSpanHttpServer({
      listen_host: runtime.config.server.listen_host,
      listen_port: runtime.config.server.listen_port,
      ...(runtime.config.server.allowed_hosts ? { allowed_hosts: runtime.config.server.allowed_hosts } : {}),
      max_inflight_mcp_requests: runtime.config.server.max_inflight_mcp_requests ?? 128,
      ...(runtime.oauth ? { oauth: runtime.oauth } : {}),
      authorization: runtime.authorization,
      handlers: runtime.handlers,
      responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: runtime.config.policy_epoch }),
      status: {
        health: () => ({ server_version: SERVER_VERSION }),
        readiness: () => runtimeReadiness(runtime),
      },
      trace: (event, metadata) => runtime.logger.info(event, metadata),
    });
    let address: string;
    try {
      address = await listenHostSpan(app, runtime.config.server.listen_host, runtime.config.server.listen_port);
    } catch (error) {
      await app.close().catch(() => undefined);
      await runtime.close();
      throw error;
    }
    let requestShutdown!: () => void;
    const shutdownRequested = new Promise<void>((resolveShutdown) => {
      requestShutdown = resolveShutdown;
    });
    const control = await (async () => {
      try {
        const started = await startDaemonControlServer(configPath, requestShutdown);
        runtime.activateSessionOwnership();
        return started;
      } catch (error) {
        await app.close().catch(() => undefined);
        await runtime.close();
        throw error;
      }
    })();
    const shutdown = async () => {
      try {
        await runtime.supervisor.shutdown();
        await app.close();
        await runtime.close();
      } finally {
        await control.close();
        removeDaemonPid(configPath);
      }
    };
    writeDaemonPid(configPath);
    print({
      ok: true,
      address,
      mcp: `${address}/mcp`,
      listen_host: runtime.config.server.listen_host,
      allowed_hosts: runtime.config.server.allowed_hosts ?? [],
      oauth: runtime.oauth
        ? { enabled: true, public_mcp_url: runtime.oauth.publicMcpUrl, issuer: runtime.oauth.issuer }
        : { enabled: false },
      native_execution: true,
      sandboxed: false,
    });
    const onSignal = () => requestShutdown();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    await shutdownRequested;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await shutdown();
    return 0;
  }
  if (command === "status") {
    const snapshot = buildAdminSnapshot(configPath, { recent: 20 });
    print({
      server_version: snapshot.server_version,
      protocol_version: PROTOCOL_VERSION,
      toolset_hash: TOOLSET_HASH,
      toolset_version: snapshot.toolset_version,
      policy_epoch: snapshot.policy_epoch,
      daemon: snapshot.daemon,
      listen_host: snapshot.listen.host,
      listen_port: snapshot.listen.port,
      native_execution: true,
      sandboxed: false,
      targets: snapshot.targets.map((target) => ({
        target_id: target.target_id,
        label: target.label,
        ready: target.ready,
        capabilities: target.capabilities,
        ...(has(argv, "--verbose") ? { root: target.root } : {}),
      })),
      active_process_count: snapshot.active_process_count,
      terminal_sessions: snapshot.terminal.sessions,
    });
    return 0;
  }
  if (command === "admin" && argv[1] === "snapshot") {
    const recent = Number(flag(argv, "--recent") ?? "30");
    print(buildAdminSnapshot(configPath, { recent: Number.isFinite(recent) ? recent : 30 }));
    return 0;
  }
  if (command === "terminal") {
    const action = argv[1];
    if (action === "list") {
      print({ sessions: buildAdminSnapshot(configPath, { recent: 200 }).terminal.sessions });
      return 0;
    }
    if (action === "attach") {
      const processId = flag(argv, "--process") ?? argv[2];
      if (!processId) throw cliValidationError("terminal attach requires --process PROCESS_ID");
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new HostSpanError("TERMINAL_NOT_INTERACTIVE", "terminal attach requires an interactive local terminal.");
      const config = loadConfig(configPath);
      if (!config.terminal) throw new HostSpanError("TERMINAL_BACKEND_UNAVAILABLE", "terminal support is not configured.");
      const session = resolveTerminalSession(configPath, processId);
      if (!session) throw new HostSpanError("PROCESS_NOT_FOUND", `interactive process not found: ${processId}`, false, { process_id: processId });
      const manager = new PtySessionManager(config.server.data_dir, config.terminal);
      await manager.attach(session.session, has(argv, "--read-only"));
      return 0;
    }
    throw cliValidationError("terminal requires list or attach");
  }
  if (command === "smoke") {
    const targetId = flag(argv, "--target");
    if (!targetId) throw cliValidationError("smoke requires --target TARGET", { reason: "missing_argument", argument: "--target" });
    if (daemonStatus(configPath).running) {
      throw cliValidationError("hostspan smoke requires the daemon to be stopped so validation cannot mutate live recovery state.", { reason: "daemon_running" });
    }
    const runtime = createRuntime(configPath);
    try {
      const report = await runSmoke(runtime, targetId);
      print(report);
      return report.ok ? 0 : 1;
    } finally {
      await runtime.close();
    }
  }
  if (command === "targets") {
    const action = argv[1];
    const config = loadConfig(configPath);
    if (action === "list") {
      const registry = new TargetRegistry(config);
      print({ targets: registry.list().map((target) => ({ target_id: target.target_id, label: target.label, root: target.root_real, capabilities: target.capabilities })) });
      return 0;
    }
    if (action === "add") {
      const targetId = flag(argv, "--id");
      const root = flag(argv, "--root");
      if (!targetId || !root) throw cliValidationError("targets add requires --id and --root");
      const capabilities = (flag(argv, "--capabilities") ?? "read").split(",").filter(Boolean) as Array<"read" | "write" | "exec" | "git" | "terminal">;
      const execProfile = flag(argv, "--exec-profile");
      print(
        addLocalWorkspace(configPath, {
          target_id: targetId,
          label: flag(argv, "--label") ?? targetId,
          root,
          capabilities,
          ...(execProfile ? { exec_profile: execProfile } : {}),
        }),
      );
      return 0;
    }
    if (action === "remove") {
      const targetId = flag(argv, "--id") ?? argv[2];
      if (!targetId) throw cliValidationError("targets remove requires an existing target id", { reason: "missing_argument", argument: "--id" });
      if (!config.targets[targetId]) throw new HostSpanError("TARGET_NOT_FOUND", `Unknown target_id: ${targetId}`, false, { target_id: targetId });
      print(removeLocalWorkspace(configPath, targetId));
      return 0;
    }
    throw cliValidationError("targets requires list, add, or remove");
  }
  if (command === "policy" && argv[1] === "validate") {
    const config = loadConfig(configPath);
    for (const [targetId, target] of Object.entries(config.targets)) {
      if (target.exec_profile && !config.exec_profiles[target.exec_profile]) throw cliValidationError(`target ${targetId} references missing exec profile ${target.exec_profile}`);
    }
    print({ ok: true, policy_epoch: config.policy_epoch, native_execution: true, sandboxed: false });
    return 0;
  }
  if (command === "support-export") {
    const config = loadConfig(configPath);
    const targets = new TargetRegistry(config);
    const statePath = join(config.server.data_dir, "state.db");
    const db = existsSync(statePath) ? openReadOnlyDatabase(statePath) : openMemoryDatabase();
    try {
      const positional = argv.slice(1).find((item) => !item.startsWith("--") && item !== flag(argv, "--config"));
      const output = resolve(positional ?? `hostspan-support-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      writeSupportExportAtomic(
        output,
        buildSupportExport({
          config,
          targets,
          audit: new AuditRepo(db),
          processes: new ProcessesRepo(db),
        }),
      );
      print({ ok: true, path: output });
    } finally {
      db.close();
    }
    return 0;
  }
  if (command === "logs") {
    const config = loadConfig(configPath);
    const path = join(config.server.data_dir, "logs", "hostspan.jsonl");
    if (existsSync(path)) process.stdout.write(readFileSync(path, "utf8"));
    if (!has(argv, "--follow")) return 0;
    let offset = existsSync(path) ? readFileSync(path).length : 0;
    await new Promise<void>((resolveFollow) => {
      watchFile(path, { interval: 500 }, () => {
        if (!existsSync(path)) return;
        const data = readFileSync(path);
        if (data.length < offset) offset = 0;
        if (data.length > offset) process.stdout.write(data.subarray(offset));
        offset = data.length;
      });
      const stop = () => {
        unwatchFile(path);
        resolveFollow();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  }
  if (command === "service") {
    const action = argv[1];
    if (action === "install") {
      const result = installSystemdService(configPath, fileURLToPath(import.meta.url));
      print(result);
      return result.ok ? 0 : 1;
    }
    if (["start", "stop", "restart", "status"].includes(action ?? "")) {
      const result = runServiceCommand(action as "start" | "stop" | "restart" | "status");
      print(result);
      return result.ok ? 0 : 1;
    }
    throw cliValidationError("service requires install|start|stop|restart|status");
  }
  throw cliValidationError(`unknown command: ${command}`, { reason: "unknown_command", command });
}

function isDirectCliEntry(argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return resolve(argvPath) === resolve(modulePath);
  }
}

const direct = isDirectCliEntry(process.argv[1]);
if (direct) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const known = asHostSpanError(error);
      process.stderr.write(`${JSON.stringify({ error: { code: known.code, message: known.message, retryable: known.retryable, details: known.details } })}\n`);
      process.exitCode = 1;
    },
  );
}
