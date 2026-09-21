import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { HostSpanError } from "../mcp/errors.js";
import { matchesAnyPolicyGlob } from "../policy/glob.js";
import type { TargetRuntime } from "../targets/registry.js";
import { resolveTargetPath } from "./path-guard.js";

const DEFAULT_MAX_STATUS_BYTES = 1024 * 1024;
const MAX_GIT_STDERR_BYTES = 64 * 1024;

interface GitStatusEntry {
  status: string;
  path: string;
  original_path?: string;
}

function parsePorcelainV1Z(stdout: string): GitStatusEntry[] {
  const fields = stdout.split("\0");
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const originalPath = fields[index + 1];
      if (!originalPath) throw new HostSpanError("POLICY_UNENFORCEABLE", "Git rename/copy status was incomplete.", true);
      entries.push({ status, path, original_path: originalPath });
      index += 1;
    } else {
      entries.push({ status, path });
    }
  }
  return entries;
}

interface BoundedGitOutput {
  stdout: Buffer;
  total_stdout_bytes: number;
  stderr: string;
}

function decodeUtf8Prefix(buffer: Buffer): string {
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim += 1) {
    const candidate = trim === 0 ? buffer : buffer.subarray(0, buffer.length - trim);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(candidate);
    } catch {
      // A truncation boundary can cut at most one four-byte UTF-8 code point.
    }
  }
  return buffer.toString("utf8");
}

function collectGitOutput(cwd: string, args: string[], maxStdoutBytes: number): Promise<BoundedGitOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let capturedStdoutBytes = 0;
    let capturedStderrBytes = 0;
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      const remaining = maxStdoutBytes - capturedStdoutBytes;
      if (remaining > 0) {
        const captured = bytes.subarray(0, remaining);
        stdoutChunks.push(captured);
        capturedStdoutBytes += captured.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      const remaining = MAX_GIT_STDERR_BYTES - capturedStderrBytes;
      if (remaining > 0) {
        const captured = bytes.subarray(0, remaining);
        stderrChunks.push(captured);
        capturedStderrBytes += captured.length;
      }
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(`git ${args[0] ?? "<command>"} exited ${code ?? "null"}${signal ? ` (${signal})` : ""}${stderr ? `: ${stderr}` : ""}`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        total_stdout_bytes: stdoutBytes,
        stderr,
      });
    });
  });
}

async function boundedDiff(cwd: string, args: string[], maxDiffBytes: number): Promise<{ text: string; truncated: boolean }> {
  const result = await collectGitOutput(cwd, args, maxDiffBytes);
  return {
    text: decodeUtf8Prefix(result.stdout),
    truncated: result.total_stdout_bytes > result.stdout.length,
  };
}

async function boundedStatus(cwd: string, args: string[], maxStatusBytes: number): Promise<string> {
  const result = await collectGitOutput(cwd, args, maxStatusBytes);
  if (result.total_stdout_bytes > result.stdout.length) {
    throw new HostSpanError(
      "OUTPUT_LIMIT",
      "Git status exceeded HostSpan's bounded status output; narrow git_changes.paths or exclude untracked files.",
      false,
      { resource: "git_status", max_status_bytes: maxStatusBytes },
    );
  }
  return result.stdout.toString("utf8");
}

export async function gitChanges(
  target: TargetRuntime,
  paths: string[],
  maxDiffBytes: number,
  includeUntracked: boolean,
  maxStatusBytes = DEFAULT_MAX_STATUS_BYTES,
) {
  const guardedPaths = paths.length ? paths.map((path) => resolveTargetPath(target, path, "read")) : [resolveTargetPath(target, ".", "read")];
  const repositoryRoots = guardedPaths.map((guarded) => {
    let current = guarded.exists && statSync(guarded.absolute).isDirectory() ? guarded.absolute : dirname(guarded.absolute);
    for (;;) {
      if (existsSync(join(current, ".git"))) return current;
      if (current === target.root_real) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    throw new HostSpanError("NOT_A_GIT_REPOSITORY", `Path is not inside a Git repository: ${guarded.relative}`);
  });
  const repositoryRoot = repositoryRoots[0] ?? target.root_real;
  if (repositoryRoots.some((root) => root !== repositoryRoot)) {
    throw new HostSpanError("SCOPE_DENIED", "git_changes paths must belong to one Git repository.", false, {
      reason: "multiple_git_repositories",
    });
  }
  const repositoryPath = relative(target.root_real, repositoryRoot).replaceAll("\\", "/") || ".";
  const includePaths = paths.length
    ? guardedPaths.map((guarded) => relative(repositoryRoot, guarded.absolute).replaceAll("\\", "/") || ".")
    : ["."];
  const pathArgs = ["--", ...includePaths];
  const statusArgs = ["status", "--porcelain=v1", "-z", ...(includeUntracked ? ["--untracked-files=normal"] : ["--untracked-files=no"]), ...pathArgs];
  const status = await boundedStatus(repositoryRoot, statusArgs, maxStatusBytes);
  const targetRelative = (path: string) => (repositoryPath === "." ? path : `${repositoryPath}/${path}`);
  const statusEntries = parsePorcelainV1Z(status).filter((entry) => {
    if (matchesAnyPolicyGlob(targetRelative(entry.path), target.deny_globs)) return false;
    if (entry.original_path && matchesAnyPolicyGlob(targetRelative(entry.original_path), target.deny_globs)) return false;
    return true;
  });
  const diffPaths = [
    ...new Set(statusEntries.flatMap((entry) => [entry.path, ...(entry.original_path ? [entry.original_path] : [])])),
  ];
  const emptyDiff = { text: "", truncated: false };
  const [staged, unstaged] = diffPaths.length
    ? await Promise.all([
        boundedDiff(repositoryRoot, ["diff", "--cached", "--no-ext-diff", "--no-color", "--binary", "--", ...diffPaths], maxDiffBytes),
        boundedDiff(repositoryRoot, ["diff", "--no-ext-diff", "--no-color", "--binary", "--", ...diffPaths], maxDiffBytes),
      ])
    : [emptyDiff, emptyDiff];
  const combined = [staged.text, unstaged.text].filter(Boolean).join("\n");
  const combinedBytes = Buffer.from(combined, "utf8");
  const diffText = decodeUtf8Prefix(combinedBytes.subarray(0, maxDiffBytes));
  return {
    repository_path: repositoryPath,
    status: statusEntries,
    diff: diffText,
    diff_truncated: staged.truncated || unstaged.truncated || combinedBytes.length > maxDiffBytes,
  };
}
