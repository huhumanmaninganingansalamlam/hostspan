#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOAuthSetup, OAuthService, rotateOAuthApprovalSecret } from "../auth/oauth-service.js";
import { buildAdminSnapshot, resolveTerminalSession } from "../admin/snapshot.js";
import type { HostSpanConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { writeConfigAtomic } from "../config/writer.js";
import { gitChanges } from "../files/git-changes.js";
import { fileList } from "../files/list.js";
import { FilePatchService, recoverPatchTransactions } from "../files/patch.js";
import { resolveTargetPath } from "../files/path-guard.js";
import { fileRead } from "../files/read.js";
import { fileSearch, SearchConcurrencyLimiter } from "../files/search.js";
import { asHostSpanError } from "../mcp/errors.js";
import { TOOL_NAMES, TOOLSET_HASH, toolsetDocument, type HostSpanToolHandlers } from "../mcp/registry.js";
import { createHostSpanHttpServer, listenHostSpan } from "../mcp/server.js";
import type {
  FileListToolInput,
  FilePatchToolInput,
  FileReadToolInput,
  FileSearchToolInput,
  GitChangesToolInput,
  ProcessCancelToolInput,
  ProcessPollToolInput,
  ProcessStartToolInput,
  ProcessWriteToolInput,
  SystemStatusInput,
  TargetListInput,
} from "../mcp/schemas.js";
import { HostSpanLogger } from "../observability/logger.js";
import { buildSupportExport, writeSupportExportAtomic } from "../observability/support-export.js";
import { PolicyEvaluator } from "../policy/evaluator.js";
import { cleanupExpiredProcessSpools } from "../processes/output-spool.js";
import type { InteractiveSessionManager } from "../processes/interactive-session.js";
import { PtySessionManager } from "../processes/pty-session.js";
import { recoverProcesses } from "../processes/recovery.js";
import { ProcessSupervisor } from "../processes/supervisor.js";
import { AuditRepo } from "../state/audit-repo.js";
import { databaseResponsive, openDatabase, syncTargetSnapshots, type HostSpanDatabase } from "../state/database.js";
import { argumentHash, OperationsRepo } from "../state/operations-repo.js";
import { OAuthRepo } from "../state/oauth-repo.js";
import { ProcessesRepo } from "../state/processes-repo.js";
import { TransactionsRepo } from "../state/transactions-repo.js";
import { TargetRegistry } from "../targets/registry.js";
import { PROTOCOL_VERSION, SERVER_VERSION, TOOLSET_VERSION } from "../version.js";
import { runDoctor } from "./doctor.js";
import { daemonStatus, removeDaemonPid, startDaemon, stopDaemon, writeDaemonPid } from "./daemon.js";
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
  close(): void;
}

export function runtimeReadiness(runtime: HostSpanRuntime) {
  let databaseReady = false;
  try {
    databaseReady = databaseResponsive(runtime.db);
  } catch {
    databaseReady = false;
  }
  const processReady = process.platform === "linux";
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

function defaultConfigPath(): string {
  return process.env.HOSTSPAN_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "hostspan", "config.yaml");
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

function cachedExecutableProbe(command: string, args: string[] = ["--version"], ttlMs = 5_000): () => boolean {
  let checkedAt = 0;
  let ready = false;
  return () => {
    const now = Date.now();
    if (checkedAt === 0 || now - checkedAt >= ttlMs) {
      ready = spawnSync(command, args, { stdio: "ignore" }).status === 0;
      checkedAt = now;
    }
    return ready;
  };
}

function cachedNodeModuleProbe(specifier: string, ttlMs = 5_000): () => boolean {
  let checkedAt = 0;
  let ready = false;
  return () => {
    const now = Date.now();
    if (checkedAt === 0 || now - checkedAt >= ttlMs) {
      const script = `import(${JSON.stringify(specifier)}).then(()=>process.exit(0)).catch(()=>process.exit(1))`;
      ready =
        ["linux", "darwin"].includes(process.platform) &&
        spawnSync(process.execPath, ["-e", script], {
          stdio: "ignore",
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
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
  return path;
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase());
}

export function createRuntime(configPath = defaultConfigPath()): HostSpanRuntime {
  const resolvedConfigPath = resolve(configPath);
  const config = loadConfig(resolvedConfigPath);
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
  recoverPatchTransactions(targets, operations, transactions);
  const terminal = config.terminal ? new PtySessionManager(config.server.data_dir, config.terminal) : undefined;
  const recoveredProcesses = recoverProcesses(processes, operations, terminal);
  for (const recovered of recoveredProcesses) logger.info("process.recovered", recovered);
  const cleanup = cleanupExpiredProcessSpools(
    config.server.data_dir,
    processes.expiredOutput().map((record) => record.process_id),
    config.retention.max_total_spool_bytes,
  );
  if (cleanup.over_quota) logger.info("spool.quota_exceeded", cleanup);

  const patchService = new FilePatchService({ data_dir: config.server.data_dir, operations, transactions, policy });
  const supervisor = new ProcessSupervisor({ config, targets, policy, operations, processes, ...(terminal ? { terminal } : {}), logger });
  const searchLimiter = new SearchConcurrencyLimiter(
    config.server.max_concurrent_searches ?? 8,
    config.server.max_queued_searches ?? 16,
    config.server.search_queue_timeout_ms ?? 1_000,
  );
  const searchBackendReady = cachedExecutableProbe("rg");
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
        metadata: { tool, stage: "handler", error_code: known.code, total_ms: Date.now() - started },
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
            process: { name: "linux_process_group", ready: process.platform === "linux" },
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
          git_repository: target.git_repository,
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
    git_changes: (input: GitChangesToolInput, requestId: string) =>
      traced("git_changes", input, requestId, async () => {
        const target = targets.get(input.target_id, "git");
        for (const path of input.paths) {
          const guarded = resolveTargetPath(target, path, "read");
          policy.assertFileAllowed(target, guarded.relative, guarded.absolute, false);
        }
        return gitChanges(target, input.paths, input.max_diff_bytes, input.include_untracked);
      }),
    process_start: (input: ProcessStartToolInput, requestId: string) =>
      traced("process_start", input, requestId, () => supervisor.start(input, requestId)),
    process_poll: (input: ProcessPollToolInput, requestId: string) =>
      traced("process_poll", input, requestId, () => supervisor.poll(input)),
    process_write: (input: ProcessWriteToolInput, requestId: string) =>
      traced("process_write", input, requestId, () => supervisor.write(input)),
    process_cancel: (input: ProcessCancelToolInput, requestId: string) =>
      traced("process_cancel", input, requestId, () => supervisor.cancel(input)),
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
    close: () => db.close(),
  };
}

function initialConfig(): HostSpanConfig {
  return {
    schema_version: 1,
    policy_epoch: 1,
    server: {
      listen_host: "127.0.0.1",
      listen_port: 39393,
      allowed_hosts: [],
      data_dir: join(homedir(), ".local", "state", "hostspan"),
      max_inflight_mcp_requests: 128,
      max_concurrent_searches: 8,
      max_queued_searches: 16,
      search_queue_timeout_ms: 1_000,
    },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_audit_events: 500_000,
      max_total_spool_bytes: 1_073_741_824,
    },
    terminal: {
      backend: "pty",
      max_concurrent_sessions: 4,
      attach_history_bytes: 65_536,
      max_output_bytes: 16_777_216,
    },
    targets: {},
    exec_profiles: {
      "native-dev": {
        mode: "native",
        allowed_programs: ["git", "node", "npm", "pnpm", "python", "pytest", "cargo"],
        env_allowlist: ["LANG", "LC_ALL", "CI", "NODE_ENV"],
        default_deadline_ms: 30_000,
        max_deadline_ms: 600_000,
        default_output_bytes: 4_194_304,
        max_output_bytes: 67_108_864,
        max_concurrent_processes: 4,
      },
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
    throw new Error("daemon requires start, stop, or status");
  }
  if (command === "init") {
    if (existsSync(configPath)) throw new Error(`config already exists: ${configPath}`);
    writeConfigAtomic(configPath, initialConfig());
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
      if (config.oauth) throw new Error("OAuth is already configured. Use hostspan oauth rotate-secret to rotate credentials.");
      const publicUrl = flag(argv, "--public-url");
      if (!publicUrl) throw new Error("oauth init requires --public-url https://host/mcp");
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
      if (!config.oauth) throw new Error("OAuth is not configured. Run hostspan oauth init first.");
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
    throw new Error("oauth requires init, status, or rotate-secret");
  }
  if (command === "serve") {
    const existingDaemon = daemonStatus(configPath);
    if (existingDaemon.running && existingDaemon.pid !== process.pid) {
      throw new Error(`HostSpan is already running with pid ${existingDaemon.pid}.`);
    }
    const runtime = createRuntime(configPath);
    if (!isLoopbackHost(runtime.config.server.listen_host) && !runtime.oauth) {
      runtime.close();
      throw new Error("Non-loopback listen_host requires OAuth. Run hostspan oauth init --public-url https://<host>/mcp first.");
    }
    const app = createHostSpanHttpServer({
      listen_host: runtime.config.server.listen_host,
      listen_port: runtime.config.server.listen_port,
      ...(runtime.config.server.allowed_hosts ? { allowed_hosts: runtime.config.server.allowed_hosts } : {}),
      max_inflight_mcp_requests: runtime.config.server.max_inflight_mcp_requests ?? 128,
      ...(runtime.oauth ? { oauth: runtime.oauth } : {}),
      handlers: runtime.handlers,
      responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: runtime.config.policy_epoch }),
      status: {
        health: () => ({ server_version: SERVER_VERSION }),
        readiness: () => runtimeReadiness(runtime),
      },
      trace: (event, metadata) => runtime.logger.info(event, metadata),
    });
    const address = await listenHostSpan(app, runtime.config.server.listen_host, runtime.config.server.listen_port);
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
    const shutdown = async () => {
      try {
        await runtime.supervisor.shutdown();
        await app.close();
        runtime.close();
      } finally {
        removeDaemonPid(configPath);
      }
    };
    await new Promise<void>((resolveShutdown) => {
      const onSignal = () => {
        void shutdown().finally(resolveShutdown);
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    });
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
      if (!processId) throw new Error("terminal attach requires --process PROCESS_ID");
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("terminal attach requires an interactive local terminal.");
      const config = loadConfig(configPath);
      if (!config.terminal) throw new Error("terminal support is not configured.");
      const session = resolveTerminalSession(configPath, processId);
      if (!session) throw new Error(`interactive process not found: ${processId}`);
      const manager = new PtySessionManager(config.server.data_dir, config.terminal);
      await manager.attach(session.session, has(argv, "--read-only"));
      return 0;
    }
    throw new Error("terminal requires list or attach");
  }
  if (command === "smoke") {
    const targetId = flag(argv, "--target");
    if (!targetId) throw new Error("smoke requires --target TARGET");
    const runtime = createRuntime(configPath);
    try {
      const report = await runSmoke(runtime, targetId);
      print(report);
      return report.ok ? 0 : 1;
    } finally {
      runtime.close();
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
      if (!targetId || !root) throw new Error("targets add requires --id and --root");
      if (config.targets[targetId]) throw new Error(`target already exists: ${targetId}`);
      const capabilities = (flag(argv, "--capabilities") ?? "read,write,exec,git").split(",").filter(Boolean) as Array<"read" | "write" | "exec" | "git" | "terminal">;
      const execProfile = flag(argv, "--exec-profile") ?? (capabilities.includes("exec") ? "native-dev" : undefined);
      if (execProfile && !config.exec_profiles[execProfile]) throw new Error(`unknown exec profile: ${execProfile}`);
      config.targets[targetId] = {
        label: flag(argv, "--label") ?? targetId,
        provider: "local",
        root: resolve(root),
        capabilities,
        ...(execProfile ? { exec_profile: execProfile } : {}),
        deny_globs: ["**/.env*", "**/*.pem", "**/*.key", ".git/objects/**"],
        ignore_globs: ["**/node_modules/**", "**/dist/**", "**/.cache/**"],
      };
      config.policy_epoch += 1;
      writeConfigAtomic(configPath, config);
      print({ ok: true, target_id: targetId, policy_epoch: config.policy_epoch });
      return 0;
    }
    if (action === "remove") {
      const targetId = flag(argv, "--id") ?? argv[2];
      if (!targetId || !config.targets[targetId]) throw new Error("targets remove requires an existing target id");
      delete config.targets[targetId];
      config.policy_epoch += 1;
      writeConfigAtomic(configPath, config);
      print({ ok: true, target_id: targetId, policy_epoch: config.policy_epoch });
      return 0;
    }
    throw new Error("targets requires list, add, or remove");
  }
  if (command === "policy" && argv[1] === "validate") {
    const config = loadConfig(configPath);
    for (const [targetId, target] of Object.entries(config.targets)) {
      if (target.exec_profile && !config.exec_profiles[target.exec_profile]) throw new Error(`target ${targetId} references missing exec profile ${target.exec_profile}`);
    }
    print({ ok: true, policy_epoch: config.policy_epoch, native_execution: true, sandboxed: false });
    return 0;
  }
  if (command === "support-export") {
    const runtime = createRuntime(configPath);
    try {
      const positional = argv.slice(1).find((item) => !item.startsWith("--") && item !== flag(argv, "--config"));
      const output = resolve(positional ?? `hostspan-support-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      writeSupportExportAtomic(output, buildSupportExport(runtime));
      print({ ok: true, path: output });
    } finally {
      runtime.close();
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
    throw new Error("service requires install|start|stop|restart|status");
  }
  throw new Error(`unknown command: ${command}`);
}

const direct = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
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
