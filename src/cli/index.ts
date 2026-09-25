#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOAuthSetup, rotateOAuthApprovalSecret } from "../auth/oauth-service.js";
import { addLocalWorkspace, buildAdminSnapshot, removeLocalWorkspace, resolveTerminalSession } from "../admin/snapshot.js";
import { loadConfig } from "../config/loader.js";
import { defaultConfigPath, oauthApprovalSecretPath } from "../config/paths.js";
import { createInitialConfig } from "../config/defaults.js";
import { writeConfigAtomic } from "../config/writer.js";
import { asHostSpanError, HostSpanError } from "../errors.js";
import { TOOLSET_HASH, toolsetDocument } from "../mcp/registry.js";
import { createHostSpanHttpServer } from "../mcp/server.js";
import { buildSupportExport, writeSupportExportAtomic } from "../observability/support-export.js";
import { protectWindowsFile } from "../security/windows-acl.js";
import { PtySessionManager } from "../processes/pty-session.js";
import { AuditRepo } from "../state/audit-repo.js";
import { openDatabase, openMemoryDatabase, openReadOnlyDatabase } from "../state/database.js";
import { OAuthRepo } from "../state/oauth-repo.js";
import { ProcessesRepo } from "../state/processes-repo.js";
import { TargetRegistry } from "../targets/registry.js";
import { PROTOCOL_VERSION, SERVER_VERSION } from "../version.js";
import { runDoctor } from "../diagnostics/doctor.js";
import { daemonStatus, removeDaemonPid, startDaemon, startDaemonControlServer, stopDaemon, writeDaemonPid } from "../daemon/control.js";
import { installSystemdService, runServiceCommand } from "../services/systemd.js";
import { runSmoke } from "./smoke.js";
import { createRuntime, runtimeReadiness } from "../runtime/create-runtime.js";

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
    const runtime = createRuntime(configPath, { deferActivation: true });
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
      address = await app.listen({ host: runtime.config.server.listen_host, port: runtime.config.server.listen_port });
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
      let started: Awaited<ReturnType<typeof startDaemonControlServer>> | undefined;
      try {
        started = await startDaemonControlServer(configPath, requestShutdown);
        runtime.activate();
        return started;
      } catch (error) {
        await started?.close();
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
      const capabilities = (flag(argv, "--capabilities") ?? "read").split(",").filter(Boolean) as Array<"read" | "write" | "exec" | "terminal">;
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
        }, TOOLSET_HASH),
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
