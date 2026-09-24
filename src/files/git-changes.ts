import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { HostSpanError } from "../mcp/errors.js";
import { BoundedConcurrencyLimiter } from "../runtime/concurrency-limiter.js";
import { matchesAnyPolicyGlob } from "../policy/glob.js";
import type { TargetRuntime } from "../targets/registry.js";
import { resolveTargetPath } from "./path-guard.js";

const DEFAULT_MAX_STATUS_BYTES = 1024 * 1024;
const MAX_GIT_STDERR_BYTES = 64 * 1024;
const MAX_GIT_ATTRIBUTE_BYTES = 4 * 1024 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 15_000;
const GIT_NULL_CONFIG = process.platform === "win32" ? "NUL" : "/dev/null";
const GIT_READ_ONLY_ARGS = [
  "--no-optional-locks",
  "--literal-pathspecs",
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.attributesFile=${GIT_NULL_CONFIG}`,
] as const;


export class GitConcurrencyLimiter extends BoundedConcurrencyLimiter {
  constructor(maxConcurrent: number, maxQueued: number, queueTimeoutMs: number) {
    super({
      maxConcurrent,
      maxQueued,
      queueTimeoutMs,
      resource: "git_changes",
      label: "Git inspection",
    });
  }
}

interface GitStatusEntry {
  status: string;
  path: string;
  original_path?: string;
}

interface GitChangeRecord {
  code: string;
  path: string;
  original_path?: string;
}

interface BoundedGitOutput {
  stdout: Buffer;
  total_stdout_bytes: number;
  stderr: string;
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG,
    GIT_CONFIG_SYSTEM: GIT_NULL_CONFIG,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PROTOCOL_FROM_USER: "0",
  };
}

function parseStagedNameStatusZ(stdout: string): GitChangeRecord[] {
  const fields = stdout.split("\0");
  const entries: GitChangeRecord[] = [];
  for (let index = 0; index < fields.length; ) {
    const rawStatus = fields[index++];
    if (!rawStatus) continue;
    const code = rawStatus[0];
    if (!code) continue;
    if (code === "R" || code === "C") {
      const originalPath = fields[index++];
      const path = fields[index++];
      if (!originalPath || !path) {
        throw new HostSpanError("POLICY_UNENFORCEABLE", "Git rename/copy status was incomplete.", true);
      }
      entries.push({ code, path, original_path: originalPath });
      continue;
    }
    const path = fields[index++];
    if (path) entries.push({ code, path });
  }
  return entries;
}

function parseUnstagedRawZ(stdout: string): GitChangeRecord[] {
  const fields = stdout.split("\0");
  const entries: GitChangeRecord[] = [];
  for (let index = 0; index < fields.length; ) {
    const header = fields[index++];
    if (!header) continue;
    const path = fields[index++];
    if (!path) throw new HostSpanError("POLICY_UNENFORCEABLE", "Git working-tree status was incomplete.", true);
    const match = / ([A-Z])(?:\d+)?$/.exec(header);
    if (!match?.[1]) throw new HostSpanError("POLICY_UNENFORCEABLE", "Git working-tree status was malformed.", true);
    entries.push({ code: match[1], path });
  }
  return entries;
}

function combineStatus(staged: GitChangeRecord[], unstaged: GitChangeRecord[], untracked: string[]): GitStatusEntry[] {
  const entries = new Map<string, GitStatusEntry>();
  for (const change of staged) {
    entries.set(change.path, {
      status: `${change.code} `,
      path: change.path,
      ...(change.original_path ? { original_path: change.original_path } : {}),
    });
  }
  for (const change of unstaged) {
    const existing = entries.get(change.path);
    if (existing) existing.status = `${existing.status[0] ?? " "}${change.code}`;
    else entries.set(change.path, { status: ` ${change.code}`, path: change.path });
  }
  for (const path of untracked) {
    if (!entries.has(path)) entries.set(path, { status: "??", path });
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
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

function collectGitOutput(
  cwd: string,
  args: string[],
  maxStdoutBytes: number,
  stdin?: Buffer,
  allowedExitCodes: readonly number[] = [0],
): Promise<BoundedGitOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...GIT_READ_ONLY_ARGS, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: safeGitEnvironment(),
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let capturedStdoutBytes = 0;
    let capturedStderrBytes = 0;
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_COMMAND_TIMEOUT_MS);
    timer.unref();

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
    child.stdin.on("error", () => {
      // A command may exit before consuming stdin; close/exit handling below is authoritative.
    });
    child.stdin.end(stdin);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new HostSpanError("DEADLINE_EXCEEDED", "Git inspection exceeded HostSpan's internal command deadline.", true, {
            resource: "git_changes",
            reason: "deadline_exceeded",
            deadline_ms: GIT_COMMAND_TIMEOUT_MS,
            command: args[0] ?? "git",
          }),
        );
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code === null || !allowedExitCodes.includes(code)) {
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
      "Git change metadata exceeded HostSpan's bounded status output; narrow git_changes.paths or exclude untracked files.",
      false,
      {
        resource: "git_status",
        reason: "output_limit",
        limit_bytes: maxStatusBytes,
        observed_bytes: result.total_stdout_bytes,
        max_status_bytes: maxStatusBytes,
      },
    );
  }
  return result.stdout.toString("utf8");
}

async function hasConfiguredContentFilters(cwd: string): Promise<boolean> {
  const result = await collectGitOutput(
    cwd,
    ["config", "--includes", "--name-only", "--null", "--get-regexp", "^filter[.].*[.](clean|process)$"],
    MAX_GIT_ATTRIBUTE_BYTES,
    undefined,
    [0, 1],
  );
  if (result.total_stdout_bytes > result.stdout.length) {
    throw new HostSpanError("OUTPUT_LIMIT", "Git filter configuration inspection exceeded HostSpan's internal bound.", false, {
      resource: "git_attributes",
      reason: "output_limit",
      limit_bytes: MAX_GIT_ATTRIBUTE_BYTES,
      observed_bytes: result.total_stdout_bytes,
      max_attribute_bytes: MAX_GIT_ATTRIBUTE_BYTES,
    });
  }
  return result.stdout.length > 0;
}

async function trackedPathsForAttributePreflight(cwd: string, pathArgs: string[]): Promise<string[]> {
  const result = await collectGitOutput(cwd, ["ls-files", "--cached", "-z", ...pathArgs], MAX_GIT_ATTRIBUTE_BYTES);
  if (result.total_stdout_bytes > result.stdout.length) {
    throw new HostSpanError("OUTPUT_LIMIT", "Git tracked-path attribute preflight exceeded HostSpan's internal bound.", false, {
      resource: "git_attributes",
      reason: "output_limit",
      limit_bytes: MAX_GIT_ATTRIBUTE_BYTES,
      observed_bytes: result.total_stdout_bytes,
      max_attribute_bytes: MAX_GIT_ATTRIBUTE_BYTES,
    });
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

async function preflightWorkingTreeFilters(cwd: string, pathArgs: string[]): Promise<void> {
  if (!(await hasConfiguredContentFilters(cwd))) return;
  const trackedPaths = await trackedPathsForAttributePreflight(cwd, pathArgs);
  await assertNoWorkingTreeFilters(cwd, trackedPaths);
}

async function assertNoWorkingTreeFilters(cwd: string, paths: string[]): Promise<void> {
  const uniquePaths = [...new Set(paths)];
  if (!uniquePaths.length) return;
  const input = Buffer.from(`${uniquePaths.join("\0")}\0`, "utf8");
  const result = await collectGitOutput(cwd, ["check-attr", "--stdin", "-z", "filter"], MAX_GIT_ATTRIBUTE_BYTES, input);
  if (result.total_stdout_bytes > result.stdout.length) {
    throw new HostSpanError("OUTPUT_LIMIT", "Git attribute inspection exceeded HostSpan's internal bound.", false, {
      resource: "git_attributes",
      reason: "output_limit",
      limit_bytes: MAX_GIT_ATTRIBUTE_BYTES,
      observed_bytes: result.total_stdout_bytes,
      max_attribute_bytes: MAX_GIT_ATTRIBUTE_BYTES,
    });
  }
  const fields = result.stdout.toString("utf8").split("\0");
  let filteredPathCount = 0;
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (attribute === "filter" && value && value !== "unspecified" && value !== "unset") filteredPathCount += 1;
  }
  if (filteredPathCount > 0) {
    throw new HostSpanError(
      "POLICY_UNENFORCEABLE",
      "git_changes will not execute Git content filters while operating as a read-only tool.",
      false,
      { reason: "git_content_filter_unsafe", filtered_path_count: filteredPathCount },
    );
  }
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

  await preflightWorkingTreeFilters(repositoryRoot, pathArgs);

  const [stagedText, unstagedText, untrackedText] = await Promise.all([
    boundedStatus(
      repositoryRoot,
      ["diff", "--cached", "--name-status", "-z", "-M", "-l1000", "--no-ext-diff", "--no-textconv", ...pathArgs],
      maxStatusBytes,
    ),
    boundedStatus(
      repositoryRoot,
      ["diff-files", "--raw", "-z", "--no-ext-diff", "--no-textconv", ...pathArgs],
      maxStatusBytes,
    ),
    includeUntracked
      ? boundedStatus(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z", ...pathArgs], maxStatusBytes)
      : Promise.resolve(""),
  ]);

  const status = combineStatus(
    parseStagedNameStatusZ(stagedText),
    parseUnstagedRawZ(unstagedText),
    untrackedText.split("\0").filter(Boolean),
  );
  const targetRelative = (path: string) => (repositoryPath === "." ? path : `${repositoryPath}/${path}`);
  const statusEntries = status.filter((entry) => {
    if (matchesAnyPolicyGlob(targetRelative(entry.path), target.deny_globs)) return false;
    if (entry.original_path && matchesAnyPolicyGlob(targetRelative(entry.original_path), target.deny_globs)) return false;
    return true;
  });

  const stagedPaths = new Set<string>();
  const unstagedPaths = new Set<string>();
  for (const entry of statusEntries) {
    if (entry.status === "??") continue;
    if (entry.status[0] !== " ") {
      stagedPaths.add(entry.path);
      if (entry.original_path) stagedPaths.add(entry.original_path);
    }
    if (entry.status[1] !== " ") unstagedPaths.add(entry.path);
  }

  const emptyDiff = { text: "", truncated: false };
  const [staged, unstaged] = await Promise.all([
    stagedPaths.size
      ? boundedDiff(
          repositoryRoot,
          ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "-M", "-l1000", "--", ...stagedPaths],
          maxDiffBytes,
        )
      : Promise.resolve(emptyDiff),
    unstagedPaths.size
      ? boundedDiff(
          repositoryRoot,
          ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--", ...unstagedPaths],
          maxDiffBytes,
        )
      : Promise.resolve(emptyDiff),
  ]);

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
