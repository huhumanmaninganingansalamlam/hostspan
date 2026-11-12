import { spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { spawnWindowsJobWorker } from "./windows-job-worker.mjs";

export type WindowsJobChild = ChildProcessByStdio<null, Readable, Readable>;

export interface WindowsJobReceipt {
  workerPid: number;
  targetPid: number;
}

const workerPath = fileURLToPath(new URL("./windows-job-worker.mjs", import.meta.url));

export function spawnWindowsJobProcess(input: {
  dataDir: string;
  processId: string;
  cwd: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
}): { child: WindowsJobChild; ready: Promise<WindowsJobReceipt> } {
  return spawnWindowsJobWorker(input) as { child: WindowsJobChild; ready: Promise<WindowsJobReceipt> };
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
