import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnWindowsJobProcess, windowsJobObjectProbe } from "../../src/processes/windows-job-process.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM" || attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition did not become true before timeout");
}

describe.skipIf(process.platform !== "win32")("native Windows Job Object backend", () => {
  it("proves kill-on-close support", () => {
    expect(windowsJobObjectProbe()).toMatchObject({ ok: true });
  });

  it("kills target descendants when the worker is terminated", async () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-job-object-"));
    roots.push(root);
    const descendantPath = join(root, "descendant.pid");
    const script = [
      "const {spawn}=require('node:child_process');",
      "const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'});",
      `require('node:fs').writeFileSync(${JSON.stringify(descendantPath)},String(c.pid));`,
      "c.unref();setTimeout(()=>{},60000);",
    ].join("");
    const launched = spawnWindowsJobProcess({
      dataDir: join(root, "state"),
      processId: "proc_jobtest",
      cwd: root,
      argv: [process.execPath, "-e", script],
      env: { ...process.env },
    });
    const receipt = await launched.ready;
    await waitFor(() => existsSync(descendantPath));
    const descendantPid = Number(readFileSync(descendantPath, "utf8"));
    expect(alive(receipt.targetPid)).toBe(true);
    expect(alive(descendantPid)).toBe(true);

    const closed = new Promise<void>((resolve) => launched.child.once("close", () => resolve()));
    process.kill(receipt.workerPid, "SIGKILL");
    await waitFor(() => !alive(receipt.workerPid) && !alive(receipt.targetPid) && !alive(descendantPid));
    await closed;
    expect(alive(descendantPid)).toBe(false);
  });
});
