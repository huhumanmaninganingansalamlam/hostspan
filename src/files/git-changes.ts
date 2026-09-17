import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { HostSpanError } from "../mcp/errors.js";
import type { TargetRuntime } from "../targets/registry.js";
import { resolveTargetPath } from "./path-guard.js";

const execFileAsync = promisify(execFile);

export async function gitChanges(target: TargetRuntime, paths: string[], maxDiffBytes: number, includeUntracked: boolean) {
  if (!existsSync(`${target.root_real}/.git`)) throw new HostSpanError("NOT_A_GIT_REPOSITORY", "Target is not a Git repository.");
  const safePaths = paths.map((path) => resolveTargetPath(target, path, "read").relative);
  const includePaths = safePaths.length ? safePaths : ["."];
  const deniedPathspecs = target.deny_globs.map((glob) => `:(exclude,glob)${glob}`);
  const pathArgs = ["--", ...includePaths, ...deniedPathspecs];
  const statusArgs = ["status", "--porcelain=v1", "-z", ...(includeUntracked ? ["--untracked-files=normal"] : ["--untracked-files=no"]), ...pathArgs];
  const diffArgs = ["diff", "--no-ext-diff", "--no-color", "--binary", ...pathArgs];
  const [status, diff] = await Promise.all([
    execFileAsync("git", statusArgs, { cwd: target.root_real, encoding: "utf8", maxBuffer: maxDiffBytes }),
    execFileAsync("git", diffArgs, { cwd: target.root_real, encoding: "utf8", maxBuffer: maxDiffBytes }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { stdout: "", stderr: "diff truncated" };
      throw error;
    }),
  ]);
  const statusEntries = status.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => ({ status: entry.slice(0, 2), path: entry.slice(3) }));
  const diffText = diff.stdout.slice(0, maxDiffBytes);
  return {
    status: statusEntries,
    diff: diffText,
    diff_truncated: Buffer.byteLength(diff.stdout) > maxDiffBytes || diff.stderr === "diff truncated",
  };
}
