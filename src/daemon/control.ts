import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../config/loader.js";
import { asHostSpanError, HostSpanError } from "../errors.js";
import { ComputerInputSchema, type ComputerInput } from "../computer/portal.js";
import { ProcessListInputSchema, ProcessPollInputSchema, type ProcessListToolInput, type ProcessPollToolInput } from "../tools/schemas.js";

export type DaemonComputerInput = ComputerInput | { action: "status" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function daemonPidPath(configPath: string): string {
  const config = loadConfig(configPath);
  return resolve(config.server.data_dir, "hostspan.pid");
}

function daemonControlPaths(configPath: string): { address: string; token_path: string } {
  const dataDir = resolve(loadConfig(configPath).server.data_dir);
  const token_path = join(dataDir, "daemon-control-token");
  if (process.platform === "win32") {
    const digest = createHash("sha256").update(dataDir.toLowerCase()).digest("hex").slice(0, 32);
    return { address: `\\\\.\\pipe\\hostspan-daemon-${digest}`, token_path };
  }
  return { address: join(dataDir, "daemon-control.sock"), token_path };
}

export async function startDaemonControlServer(
  configPath: string,
  onShutdown: () => void,
  onComputer?: (input: DaemonComputerInput) => Promise<unknown>,
  onProcessPoll?: (input: ProcessPollToolInput) => Promise<Record<string, unknown>>,
  onProcessList?: (input: ProcessListToolInput) => Promise<Record<string, unknown>>,
): Promise<{ address: string; close(): Promise<void> }> {
  const control = daemonControlPaths(configPath);
  mkdirSync(dirname(control.token_path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  if (process.platform !== "win32" && existsSync(control.address)) {
    await new Promise<void>((resolveProbe, rejectProbe) => {
      const probe = createConnection(control.address);
      probe.once("connect", () => {
        probe.destroy();
        rejectProbe(new HostSpanError("VALIDATION_FAILED", "A daemon already owns the control socket.", false, { reason: "daemon_control_in_use" }));
      });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolveProbe();
        else rejectProbe(error);
      });
      probe.setTimeout(2_000, () => {
        probe.destroy();
        rejectProbe(new Error("Daemon control socket did not respond."));
      });
    });
    rmSync(control.address, { force: true });
  }

  let shutdownRequested = false;
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    let input = "";
    let handled = false;
    socket.on("data", async (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > 32_768) {
        socket.destroy();
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      try {
        const request = JSON.parse(input.slice(0, newline)) as { token?: string; action?: string; input?: unknown };
        if (request.token !== token) {
          socket.end(`${JSON.stringify({ ok: false })}\n`);
          return;
        }
        if (request.action === "process_list" && onProcessList) {
          const parsed = ProcessListInputSchema.safeParse(request.input);
          if (!parsed.success) throw new HostSpanError("VALIDATION_FAILED", `Invalid process list arguments: ${parsed.error.message}`);
          socket.end(`${JSON.stringify({ ok: true, result: await onProcessList(parsed.data) })}\n`);
          return;
        }
        if (request.action === "process_poll" && onProcessPoll) {
          const parsed = ProcessPollInputSchema.safeParse(request.input);
          if (!parsed.success) throw new HostSpanError("VALIDATION_FAILED", `Invalid process poll arguments: ${parsed.error.message}`);
          socket.setTimeout(parsed.data.wait_ms + 5_000);
          socket.end(`${JSON.stringify({ ok: true, result: await onProcessPoll(parsed.data) })}\n`);
          return;
        }
        if (request.action === "computer" && onComputer) {
          const status = request.input && typeof request.input === "object" &&
            Object.keys(request.input).length === 1 && "action" in request.input && request.input.action === "status";
          const parsed = status ? { success: true as const, data: { action: "status" as const } } : ComputerInputSchema.safeParse(request.input);
          if (!parsed.success) throw new HostSpanError("VALIDATION_FAILED", "Invalid computer arguments.");
          socket.setTimeout(15_000);
          socket.end(`${JSON.stringify({ ok: true, result: await onComputer(parsed.data) })}\n`);
          return;
        }
        if (request.action !== "shutdown") {
          socket.end(`${JSON.stringify({ ok: false })}\n`);
          return;
        }
        socket.end(`${JSON.stringify({ ok: true, pid: process.pid })}\n`);
        if (!shutdownRequested) {
          shutdownRequested = true;
          setImmediate(onShutdown);
        }
      } catch (error) {
        const known = asHostSpanError(error);
        socket.end(`${JSON.stringify({ ok: false, error: { code: known.code, message: known.message,
          retryable: known.retryable, details: known.details } })}\n`);
      }
    });
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        rejectListen(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolveListen();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(control.address);
    });
    writeFileSync(control.token_path, `${token}\n`, { mode: 0o600 });
    if (process.platform !== "win32") {
      chmodSync(control.token_path, 0o600);
      chmodSync(control.address, 0o600);
    }
  } catch (error) {
    if (server.listening) {
      rmSync(control.token_path, { force: true });
      server.close();
    }
    throw error;
  }

  return {
    address: control.address,
    close: async () => {
      if (!server.listening) return;
      rmSync(control.token_path, { force: true });
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

async function requestDaemonControl(configPath: string, request: Record<string, unknown>, timeoutMs = 2_000, maxResponseChars = 24 * 1024 * 1024): Promise<Record<string, unknown> | null> {
  const control = daemonControlPaths(configPath);
  if (!existsSync(control.token_path)) return null;
  let token: string;
  try {
    token = readFileSync(control.token_path, "utf8").trim();
  } catch {
    return null;
  }
  if (!token) return null;

  return new Promise<Record<string, unknown> | null>((resolveRequest) => {
    let settled = false;
    const finish = (receipt: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveRequest(receipt);
    };
    const socket = createConnection(control.address);
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...request, token })}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > maxResponseChars) { finish(null); return; }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(JSON.parse(response.slice(0, newline)) as Record<string, unknown>);
      } catch {
        finish(null);
      }
    });
    socket.once("error", () => finish(null));
    socket.once("close", () => {
      if (!settled) finish(null);
    });
  });
}

export async function requestDaemonShutdown(configPath: string): Promise<{ ok: true; pid: number } | null> {
  const receipt = await requestDaemonControl(configPath, { action: "shutdown" });
  return receipt?.ok === true && typeof receipt.pid === "number" && Number.isInteger(receipt.pid) && receipt.pid > 0
    ? { ok: true, pid: receipt.pid } : null;
}

export async function requestDaemonComputer(configPath: string, input: DaemonComputerInput): Promise<Record<string, unknown>> {
  const receipt = await requestDaemonControl(configPath, { action: "computer", input }, 15_000);
  if (receipt?.ok === true && receipt.result && typeof receipt.result === "object") return receipt.result as Record<string, unknown>;
  const error = receipt?.error as { code: HostSpanError["code"]; message: string; retryable: boolean; details: Record<string, unknown> } | undefined;
  if (error) throw new HostSpanError(error.code, error.message, error.retryable, error.details);
  throw new HostSpanError("TARGET_NOT_READY", "The running daemon did not return a computer result. It may need an update; input delivery is unknown. Do not replay input automatically.");
}

export async function requestDaemonProcessPoll(configPath: string, input: ProcessPollToolInput): Promise<Record<string, unknown>> {
  // A byte of output may expand to six JSON characters; retain a bounded metadata allowance.
  const receipt = await requestDaemonControl(configPath, { action: "process_poll", input }, input.wait_ms + 5_000, input.max_bytes * 6 + 65_536);
  if (receipt?.ok === true && receipt.result && typeof receipt.result === "object") return receipt.result as Record<string, unknown>;
  const error = receipt?.error as { code: HostSpanError["code"]; message: string; retryable: boolean; details: Record<string, unknown> } | undefined;
  if (error) throw new HostSpanError(error.code, error.message, error.retryable, error.details);
  throw new HostSpanError("TARGET_NOT_READY", "This profile's running daemon is unavailable or does not support process poll. Use a matching daemon version; no process was started or cancelled.");
}

export async function requestDaemonProcessList(configPath: string, input: ProcessListToolInput): Promise<Record<string, unknown>> {
  const receipt = await requestDaemonControl(configPath, { action: "process_list", input });
  if (receipt?.ok === true && receipt.result && typeof receipt.result === "object") return receipt.result as Record<string, unknown>;
  const error = receipt?.error as { code: HostSpanError["code"]; message: string; retryable: boolean; details: Record<string, unknown> } | undefined;
  if (error) throw new HostSpanError(error.code, error.message, error.retryable, error.details);
  throw new HostSpanError("TARGET_NOT_READY", "This profile's running daemon is unavailable or does not support process list. Use a matching daemon version; no process was started or cancelled.");
}

function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  const value = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function readDaemonPid(configPath: string): number | null {
  return readPidFile(daemonPidPath(configPath));
}

export function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

export function writeDaemonPid(configPath: string, pid = process.pid): string {
  const path = daemonPidPath(configPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${pid}\n`, { mode: 0o600 });
  return path;
}

export function removeDaemonPid(configPath: string, pid = process.pid): void {
  const path = daemonPidPath(configPath);
  if (!existsSync(path)) return;
  const current = readPidFile(path);
  if (current === pid || !pidAlive(current)) rmSync(path, { force: true });
}

export function daemonStatus(configPath: string): { running: boolean; pid: number | null; pid_file: string } {
  const pid_file = daemonPidPath(configPath);
  const pid = readPidFile(pid_file);
  const running = pidAlive(pid);
  return { running, pid: running ? pid : null, pid_file };
}

export async function startDaemon(
  configPath: string,
  cliPath = process.argv[1] ?? "hostspan",
  nodePath = process.execPath,
): Promise<{ running: boolean; pid: number | null }> {
  const current = daemonStatus(configPath);
  if (current.running) return { running: true, pid: current.pid };
  const child = spawn(nodePath, [resolve(cliPath), "serve", "--config", resolve(configPath)], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  });
  child.unref();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = daemonStatus(configPath);
    if (status.running) return { running: true, pid: status.pid };
    await sleep(50);
  }
  return { running: false, pid: null };
}

export async function stopDaemon(configPath: string): Promise<{ running: boolean; pid: number | null }> {
  const current = daemonStatus(configPath);
  if (!current.running || !current.pid) return { running: false, pid: null };
  const receipt = await requestDaemonShutdown(configPath);
  if (!receipt || receipt.pid !== current.pid) {
    throw new HostSpanError(
      "VALIDATION_FAILED",
      `Refusing to signal pid ${current.pid}: the authenticated HostSpan daemon control channel did not confirm that process identity.`,
      false,
      { reason: "daemon_identity_unconfirmed", pid: current.pid },
    );
  }
  const stages: Array<[NodeJS.Signals | null, number]> = [[null, 5_000]];
  if (process.platform !== "win32") stages.push(["SIGTERM", 1_000]);
  stages.push(["SIGKILL", 1_000]);
  for (const [signal, waitMs] of stages) {
    if (signal) {
      try {
        process.kill(current.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const deadline = Date.now() + waitMs;
    do {
      if (!pidAlive(current.pid)) {
        removeDaemonPid(configPath, current.pid);
        return { running: false, pid: null };
      }
      await sleep(50);
    } while (Date.now() < deadline);
  }
  return { running: true, pid: current.pid };
}
