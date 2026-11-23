#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigPath } from "../config/paths.js";
import { asHostSpanError, HostSpanError } from "../errors.js";
import { TOOLSET_HASH, toolsetDocument, toolsetHash } from "../mcp/registry.js";
import { createHostSpanHttpServer } from "../mcp/server.js";
import { BUILD_IDENTITY, PROTOCOL_VERSION, SERVER_VERSION, TOOLSET_VERSION } from "../version.js";
import { daemonStatus, removeDaemonPid, startDaemonControlServer, writeDaemonPid } from "../daemon/control.js";
import { runProcessCommand } from "./commands/process.js";
import { runAccessTokenCommand } from "./commands/access-token.js";
import { runOAuthCommand } from "./commands/oauth.js";
import { runComputerCommand } from "./commands/computer.js";
import { runDaemonCommand } from "./commands/daemon.js";
import {
  runAdminSnapshotCommand,
  runDoctorCommand,
  runInitCommand,
  runLogsCommand,
  runSmokeCommand,
  runStatusCommand,
  runSupportExportCommand,
} from "./commands/diagnostics.js";
import { runServiceCliCommand } from "./commands/service.js";
import { runTerminalCommand } from "./commands/terminal.js";
import { runPolicyValidateCommand, runTargetsCommand } from "./commands/targets.js";
import type { CliCommandContext } from "./context.js";
import { createRuntime, runtimeReadiness } from "../runtime/create-runtime.js";
import { errorResult, requestId, successResult } from "../mcp/result.js";

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

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase());
}

function usage(): string {
  return `HostSpan ${SERVER_VERSION}\n\nCommands:\n  init [--config PATH]\n  serve [--config PATH]\n  daemon start|stop|status [--config PATH]\n  doctor [--config PATH]\n  computer status|enable|disable [--json] [--config PATH]\n  computer inspect [--config PATH]\n  computer call --input JSON [--config PATH]\n    Use this profile owner's authenticated daemon and existing desktop session.\n  smoke --target TARGET [--config PATH]\n  status [--verbose] [--config PATH]\n  admin snapshot [--recent N] [--config PATH]\n  terminal list|attach --process PROCESS_ID [--read-only] [--config PATH]\n  process list --target TARGET [--cwd RELATIVE_PATH] [--active-only true|false]\n    [--limit 1..500] [--cursor CURSOR] [--config PATH]\n    Discover original handles in the selected directory and descendants; active only by default.\n  process poll --process PROCESS_ID [--stdout-cursor N] [--stderr-cursor N]\n    [--wait-ms 0..1500] [--max-bytes 1..4194304] [--config PATH]\n    Read the original result through this profile owner's running daemon; never starts a process.\n  targets list|add|remove ... [--config PATH]\n  oauth init --public-url https://host/mcp [--config PATH]\n  oauth status [--config PATH]\n  oauth rotate-secret [--config PATH]\n  access token create --name CLIENT --scopes hostspan.read,hostspan.write --output FILE [--config PATH]\n  access token create --name CLIENT --scopes hostspan.read --show (trusted interactive TTY only)\n  access token list|revoke TOKEN_ID|rotate TOKEN_ID --output FILE [--config PATH]\n  policy validate [--config PATH]\n  print-toolset\n  logs [--follow] [--config PATH]\n  support-export [PATH] [--config PATH]\n  service install|start|stop|restart|status [--config PATH]\n  --version [--verbose]\n`;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return 0;
  }
  if (command === "--version" || command === "version") {
    if (has(argv, "--verbose")) {
      print({ server_version: SERVER_VERSION, protocol_version: PROTOCOL_VERSION,
        toolset_version: TOOLSET_VERSION, toolset_hash: TOOLSET_HASH, build: BUILD_IDENTITY });
    } else process.stdout.write(`${SERVER_VERSION}\n`);
    return 0;
  }
  if (command === "print-toolset") {
    print({ toolset_hash: TOOLSET_HASH, ...toolsetDocument() });
    return 0;
  }

  const configPath = resolve(flag(argv, "--config") ?? defaultConfigPath());
  const context: CliCommandContext = {
    argv,
    command,
    configPath,
    stdout: process.stdout,
    stderr: process.stderr,
    entryModuleUrl: import.meta.url,
  };
  if (command === "process") return runProcessCommand(context);
  if (command === "computer") return runComputerCommand(context);
  if (command === "daemon") return runDaemonCommand(context);
  if (command === "init") return runInitCommand(context);
  if (command === "doctor") return runDoctorCommand(context);
  if (command === "access") return runAccessTokenCommand(context);
  if (command === "oauth") return runOAuthCommand(context);
  if (command === "serve") {
    const existingDaemon = daemonStatus(configPath);
    if (existingDaemon.running && existingDaemon.pid !== process.pid) {
      throw cliValidationError(`HostSpan is already running with pid ${existingDaemon.pid}.`);
    }
    const runtime = createRuntime(configPath, { deferActivation: true });
    if (!isLoopbackHost(runtime.config.server.listen_host) && runtime.authenticationMode === "none") {
      await runtime.close();
      throw cliValidationError("Non-loopback listen_host requires OAuth or an explicitly configured private_token mode.");
    }
    const app = createHostSpanHttpServer({
      listen_host: runtime.config.server.listen_host,
      listen_port: runtime.config.server.listen_port,
      ...(runtime.config.server.allowed_hosts ? { allowed_hosts: runtime.config.server.allowed_hosts } : {}),
      max_inflight_mcp_requests: runtime.config.server.max_inflight_mcp_requests ?? 128,
      authenticationMode: runtime.authenticationMode,
      ...(runtime.config.authentication?.protected_transport ? { protected_transport: runtime.config.authentication.protected_transport } : {}),
      ...(runtime.privateTokens ? { privateTokens: runtime.privateTokens } : {}),
      ...(runtime.oauth ? { oauth: runtime.oauth } : {}),
      authorization: runtime.authorization,
      handlers: runtime.handlers,
      responseContext: () => ({ toolset_hash: toolsetHash(runtime.authenticationMode), policy_epoch: runtime.config.policy_epoch }),
      status: {
        // This unauthenticated endpoint exposes an opaque correlation ID, not Git internals.
        health: () => ({ server_version: SERVER_VERSION, build_id: BUILD_IDENTITY.build_id }),
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
        started = await startDaemonControlServer(configPath, requestShutdown, async (input) => {
          const id = requestId();
          const context = { toolset_hash: toolsetHash(runtime.authenticationMode), policy_epoch: runtime.config.policy_epoch };
          try {
            const result = input.action === "status" ? runtime.desktopComputerStatus()
              : await runtime.handlers.computer(input, id, { caller_mode: "local" });
            return successResult(context, result, id, true);
          } catch (error) {
            return errorResult(context, error, id, true);
          }
        }, async (input) => {
          const id = requestId();
          return { request_id: id, ...await runtime.handlers.process_poll(input, id) };
        }, async (input) => {
          const id = requestId();
          return { request_id: id, ...await runtime.handlers.process_list(input, id) };
        });
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
      authentication_mode: runtime.authenticationMode,
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
  if (command === "status") return runStatusCommand(context);
  if (command === "admin" && argv[1] === "snapshot") return runAdminSnapshotCommand(context);
  if (command === "terminal") return runTerminalCommand(context);
  if (command === "smoke") return runSmokeCommand(context);
  if (command === "targets") return runTargetsCommand(context);
  if (command === "policy" && argv[1] === "validate") return runPolicyValidateCommand(context);
  if (command === "support-export") return runSupportExportCommand(context);
  if (command === "logs") return runLogsCommand(context);
  if (command === "service") return runServiceCliCommand(context);
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
