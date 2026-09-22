import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, resolve } from "node:path";
import { statSync } from "node:fs";
import { HostSpanError } from "../mcp/errors.js";
import { BoundedConcurrencyLimiter } from "../runtime/concurrency-limiter.js";
import type { TargetRuntime } from "../targets/registry.js";
import { resolveTargetPath } from "./path-guard.js";
import { ripgrepExecutable } from "./ripgrep.js";
import { matchesAnyPolicyGlob } from "../policy/glob.js";

const execFileAsync = promisify(execFile);

export class SearchConcurrencyLimiter extends BoundedConcurrencyLimiter {
  constructor(maxConcurrent: number, maxQueued: number, queueTimeoutMs: number) {
    super({
      maxConcurrent,
      maxQueued,
      queueTimeoutMs,
      resource: "file_search",
      label: "Search",
    });
  }
}

export interface FileSearchInput {
  query: string;
  paths: string[];
  glob?: string | undefined;
  context_before: number;
  context_after: number;
  max_matches: number;
  max_bytes: number;
  deadline_ms: number;
}

interface RipgrepEvent {
  type: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

function tooBroad(query: string): boolean {
  const value = query.trim();
  return value.length === 0 || [".", ".*", "^.*$", "^$", "*"].includes(value);
}

export async function fileSearch(target: TargetRuntime, input: FileSearchInput) {
  if (tooBroad(input.query)) throw new HostSpanError("SEARCH_SCOPE_TOO_BROAD", "Search query is empty or effectively match-all.");
  const guardedSearchPaths = (input.paths.length ? input.paths : ["."]).map((path) => resolveTargetPath(target, path, "search"));
  const missingPath = guardedSearchPaths.find((path) => !path.exists);
  if (missingPath) {
    throw new HostSpanError("FILE_NOT_FOUND", `Search path does not exist: ${missingPath.relative}`);
  }
  const searchPaths = guardedSearchPaths.map((path) => path.relative);
  const args = [
    "--json",
    "--color",
    "never",
    "--no-messages",
    "--before-context",
    String(input.context_before),
    "--after-context",
    String(input.context_after),
    "--max-count",
    String(input.max_matches),
  ];
  if (input.glob) args.push("--glob", input.glob);
  for (const glob of target.ignore_globs) args.push("--glob", `!${glob}`);
  for (const glob of target.deny_globs) args.push("--glob", `!${glob}`);
  args.push("--", input.query, ...searchPaths);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ripgrepExecutable(), args, {
      cwd: target.root_real,
      encoding: "utf8",
      timeout: input.deadline_ms,
      maxBuffer: input.max_bytes + 64 * 1024,
    }));
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string; killed?: boolean; signal?: NodeJS.Signals | null };
    const stderr = cause.stderr ?? "";
    if (cause.code === "ENOENT") throw new HostSpanError("SEARCH_BACKEND_UNAVAILABLE", "ripgrep is required but not available.", true);
    if (String(cause.code) === "1") stdout = cause.stdout ?? "";
    else if (cause.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new HostSpanError("SEARCH_SCOPE_TOO_BROAD", "Search output exceeded max_bytes; narrow the scope.");
    else if (cause.killed) {
      throw new HostSpanError("DEADLINE_EXCEEDED", "Search exceeded its deadline.", true, {
        resource: "file_search",
        deadline_ms: input.deadline_ms,
      });
    }
    else if (/regex parse error:/i.test(stderr)) {
      throw new HostSpanError("VALIDATION_FAILED", "Search query is not a valid regular expression.", false, {
        resource: "file_search",
        reason: "invalid_regex",
      });
    }
    else if (/error parsing glob/i.test(stderr)) {
      throw new HostSpanError("VALIDATION_FAILED", "Search glob is invalid.", false, {
        resource: "file_search",
        reason: "invalid_glob",
      });
    }
    else throw new HostSpanError("SEARCH_BACKEND_UNAVAILABLE", `ripgrep failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  const records: Array<Record<string, unknown>> = [];
  let matches = 0;
  let returnedBytes = 0;
  let responseTruncated = false;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line) as RipgrepEvent;
    if (!event.data || !["match", "context"].includes(event.type)) continue;
    const pathText = event.data.path?.text as string | undefined;
    if (!pathText) continue;
    const absolute = resolve(target.root_real, pathText);
    const guarded = resolveTargetPath(target, relative(target.root_real, absolute), "search");
    const normalizedPath = guarded.relative.replaceAll("\\", "/");
    if (matchesAnyPolicyGlob(normalizedPath, target.deny_globs) || matchesAnyPolicyGlob(normalizedPath, target.ignore_globs)) {
      continue;
    }
    const stat = statSync(guarded.absolute);
    const record = {
      type: event.type,
      path: normalizedPath,
      line_number: event.data.line_number,
      text: event.data.lines?.text?.replace(/\r?\n$/, "") ?? "",
      mtime: stat.mtime.toISOString(),
    };
    const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    if (returnedBytes + recordBytes > input.max_bytes) {
      responseTruncated = true;
      break;
    }
    records.push(record);
    returnedBytes += recordBytes;
    if (event.type === "match") matches += 1;
    if (matches >= input.max_matches) {
      responseTruncated = true;
      break;
    }
  }
  return {
    matches: records,
    match_count: matches,
    truncated: responseTruncated || Buffer.byteLength(stdout) > input.max_bytes,
    backend: "ripgrep",
    binary: "ignored",
    hidden: false,
  };
}
