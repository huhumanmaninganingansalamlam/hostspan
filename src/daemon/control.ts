import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../config/loader.js";
import { HostSpanError } from "../errors.js";

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

function cleanupDaemonControlArtifacts(configPath: string): void {
  const control = daemonControlPaths(configPath);
  rmSync(control.token_path, { force: true });
  if (process.platform !== "win32") rmSync(control.address, { force: true });
}

export async function startDaemonControlServer(
  configPath: string,
  onShutdown: () => void,
): Promise<{ address: string; close(): Promise<void> }> {
  const control = daemonControlPaths(configPath);
  mkdirSync(dirname(control.token_path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(control.token_path, `${token}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(control.token_path, 0o600);
    rmSync(control.address, { force: true });
  }

  let shutdownRequested = false;
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > 4_096) {
        socket.destroy();
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        const request = JSON.parse(input.slice(0, newline)) as { token?: string; action?: string };
        if (request.token !== token || request.action !== "shutdown") {
          socket.end(`${JSON.stringify({ ok: false })}\n`);
          return;
        }
        socket.end(`${JSON.stringify({ ok: true, pid: process.pid })}\n`);
        if (!shutdownRequested) {
          shutdownRequested = true;
          setImmediate(onShutdown);
        }
      } catch {
        socket.end(`${JSON.stringify({ ok: false })}\n`);
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
    if (process.platform !== "win32") chmodSync(control.address, 0o600);
  } catch (error) {
    cleanupDaemonControlArtifacts(configPath);
    throw error;
  }

  return {
    address: control.address,
    close: async () => {
      if (server.listening) {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
      cleanupDaemonControlArtifacts(configPath);
    },
  };
}

export async function requestDaemonShutdown(configPath: string): Promise<{ ok: true; pid: number } | null> {
  const control = daemonControlPaths(configPath);
  if (!existsSync(control.token_path)) return null;
  let token: string;
  try {
    token = readFileSync(control.token_path, "utf8").trim();
  } catch {
    return null;
  }
  if (!token) return null;

  return new Promise<{ ok: true; pid: number } | null>((resolveRequest) => {
    let settled = false;
    const finish = (receipt: { ok: true; pid: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveRequest(receipt);
    };
    const socket = createConnection(control.address);
    const timer = setTimeout(() => finish(null), 2_000);
    timer.unref();
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ token, action: "shutdown" })}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(response.slice(0, newline)) as { ok?: boolean; pid?: number };
        finish(parsed.ok === true && Number.isInteger(parsed.pid) && (parsed.pid ?? 0) > 0 ? { ok: true, pid: parsed.pid as number } : null);
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
  } catch {
    return false;
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
  if (pid && !running) rmSync(pid_file, { force: true });
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
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!pidAlive(current.pid)) {
      removeDaemonPid(configPath, current.pid);
      return { running: false, pid: null };
    }
    await sleep(50);
  }
  if (process.platform !== "win32") {
    try {
      process.kill(current.pid, "SIGTERM");
    } catch {
      removeDaemonPid(configPath, current.pid);
      cleanupDaemonControlArtifacts(configPath);
      return { running: false, pid: null };
    }
    const termDeadline = Date.now() + 1_000;
    while (Date.now() < termDeadline) {
      if (!pidAlive(current.pid)) {
        removeDaemonPid(configPath, current.pid);
        cleanupDaemonControlArtifacts(configPath);
        return { running: false, pid: null };
      }
      await sleep(50);
    }
  }
  try {
    process.kill(current.pid, "SIGKILL");
  } catch {
    // Already stopped.
  }
  removeDaemonPid(configPath, current.pid);
  cleanupDaemonControlArtifacts(configPath);
  return { running: pidAlive(current.pid), pid: pidAlive(current.pid) ? current.pid : null };
}
