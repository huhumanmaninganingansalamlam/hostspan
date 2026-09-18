import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../config/loader.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function daemonPidPath(configPath: string): string {
  const config = loadConfig(configPath);
  return resolve(config.server.data_dir, "hostspan.pid");
}

export function readDaemonPid(configPath: string): number | null {
  const path = daemonPidPath(configPath);
  if (!existsSync(path)) return null;
  const value = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(value) && value > 0 ? value : null;
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
  const current = readDaemonPid(configPath);
  if (current === pid || !pidAlive(current)) rmSync(path, { force: true });
}

export function daemonStatus(configPath: string): { running: boolean; pid: number | null; pid_file: string } {
  const pid = readDaemonPid(configPath);
  const running = pidAlive(pid);
  if (pid && !running) rmSync(daemonPidPath(configPath), { force: true });
  return { running, pid: running ? pid : null, pid_file: daemonPidPath(configPath) };
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
  try {
    process.kill(current.pid, "SIGTERM");
  } catch {
    removeDaemonPid(configPath, current.pid);
    return { running: false, pid: null };
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!pidAlive(current.pid)) {
      removeDaemonPid(configPath, current.pid);
      return { running: false, pid: null };
    }
    await sleep(50);
  }
  try {
    process.kill(current.pid, "SIGKILL");
  } catch {
    // Already stopped.
  }
  removeDaemonPid(configPath, current.pid);
  return { running: pidAlive(current.pid), pid: pidAlive(current.pid) ? current.pid : null };
}
