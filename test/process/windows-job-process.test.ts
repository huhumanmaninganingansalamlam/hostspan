import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnWindowsJobProcess, windowsJobObjectProbe } from "../../src/processes/windows-job-process.js";
import { resolveWindowsCommand } from "../../src/processes/windows-command.mjs";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(code ?? "") || attempt === 39) throw error;
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

  it("round-trips cmd/bat arguments without shell metacharacter or percent expansion", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-cmd-argv-"));
    roots.push(root);
    const output = join(root, "argv.json");
    const helper = join(root, "capture.js");
    const commandFile = join(root, "capture args.cmd");
    writeFileSync(
      helper,
      "require('node:fs').writeFileSync(process.env.HOSTSPAN_ARGV_OUT,JSON.stringify(process.argv.slice(2)))",
    );
    writeFileSync(commandFile, `@"${process.execPath}" "${helper}" %*\r\n`);
    const expected = [
      "",
      "space value",
      "amp&value",
      "pipe|value",
      "caret^value",
      "bang!value",
      "percent%HOSTSPAN_META%value",
      'quote"value',
      "paren(value)",
    ];
    const env = { ...process.env, HOSTSPAN_META: "EXPANDED", HOSTSPAN_ARGV_OUT: output };
    const resolved = resolveWindowsCommand(commandFile, expected, root, env);
    const result = spawnSync(resolved.program, resolved.argv, {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(expected);
  });
});
