import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

export type WindowsJobChild = ChildProcessByStdio<null, Readable, Readable>;

export interface WindowsJobReceipt {
  workerPid: number;
  targetPid: number;
}

interface WindowsJobReadyFile {
  state: "running" | "failed";
  worker_pid: number;
  target_pid: number | null;
  reason?: string;
}

const workerPath = fileURLToPath(new URL("./windows-job-worker.mjs", import.meta.url));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readReady(path: string): WindowsJobReadyFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WindowsJobReadyFile;
  } catch {
    return undefined;
  }
}

async function waitForReady(child: WindowsJobChild, path: string, timeoutMs = 5_000): Promise<WindowsJobReceipt> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const ready = readReady(path);
    if (ready?.state === "running" && ready.target_pid && ready.worker_pid) {
      return { workerPid: ready.worker_pid, targetPid: ready.target_pid };
    }
    if (ready?.state === "failed") throw new Error(ready.reason ?? "Windows Job Object worker failed to launch the target process.");
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Windows Job Object worker exited before launch receipt (exit=${child.exitCode}, signal=${child.signalCode ?? "none"}).`);
    }
    await sleep(20);
  }
  throw new Error("Windows Job Object worker did not produce a launch receipt.");
}

export function spawnWindowsJobProcess(input: {
  dataDir: string;
  processId: string;
  cwd: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
}): { child: WindowsJobChild; ready: Promise<WindowsJobReceipt> } {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(`Windows Job Object backend requires win32/x64, got ${process.platform}/${process.arch}`);
  }
  const dir = join(input.dataDir, "spools", "processes", input.processId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const specPath = join(dir, `windows-job-${process.pid}.json`);
  const readyPath = join(dir, "windows-job-ready.json");
  rmSync(readyPath, { force: true });
  writeFileSync(
    specPath,
    `${JSON.stringify({ cwd: input.cwd, argv: input.argv, env: input.env, readyPath })}\n`,
    { mode: 0o600 },
  );
  try {
    chmodSync(specPath, 0o600);
  } catch {
    // Windows ACLs, not POSIX mode bits, are authoritative.
  }
  const child = spawn(process.execPath, [workerPath, "--spec", specPath], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  });
  return { child, ready: waitForReady(child, readyPath) };
}

export function windowsJobObjectProbe(): { ok: boolean; details: string } {
  if (process.platform !== "win32" || process.arch !== "x64") {
    return { ok: false, details: `Windows Job Object backend requires win32/x64, got ${process.platform}/${process.arch}.` };
  }
  const result = spawnSync(process.execPath, [workerPath, "--probe"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    env: {
      ...process.env,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  });
  if (result.status !== 0) {
    return { ok: false, details: result.stderr.trim() || result.error?.message || `Job Object probe exited ${result.status}` };
  }
  const pid = Number(/child=(\d+)/.exec(result.stdout)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, details: `Invalid Job Object probe receipt: ${result.stdout.trim()}` };
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleeper, 0, 0, 100);
  try {
    process.kill(pid, 0);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best-effort cleanup if the invariant failed.
    }
    return { ok: false, details: `Job Object probe child ${pid} survived worker exit.` };
  } catch {
    return { ok: true, details: "Windows Job Object kill-on-close process-tree control succeeded" };
  }
}
