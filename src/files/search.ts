import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import { statSync } from "node:fs";
import { HostSpanError } from "../errors.js";
import type { TargetRuntime } from "../targets/registry.js";
import { resolveTargetPath } from "../targets/path.js";
import { ripgrepExecutable } from "./ripgrep.js";
import { matchesAnyPolicyGlob } from "../policy/glob.js";

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

export async function fileSearch(target: TargetRuntime, input: FileSearchInput) {
  const guardedSearchPaths = (input.paths.length ? input.paths : ["."]).map((path) => resolveTargetPath(target, path));
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
  const records: Array<Record<string, unknown>> = [];
  let matches = 0;
  let returnedBytes = 0;
  let responseTruncated = false;
  let truncationReason: "max_bytes" | "max_matches" | "backend_output" | undefined;
  const consume = (line: string) => {
    if (!line) return;
    const event = JSON.parse(line) as RipgrepEvent;
    if (!event.data || !["match", "context"].includes(event.type)) return;
    const pathText = event.data.path?.text as string | undefined;
    if (!pathText) return;
    const absolute = resolve(target.root_real, pathText);
    const guarded = resolveTargetPath(target, relative(target.root_real, absolute));
    const normalizedPath = guarded.relative.replaceAll("\\", "/");
    if (matchesAnyPolicyGlob(normalizedPath, target.deny_globs) || matchesAnyPolicyGlob(normalizedPath, target.ignore_globs)) {
      return;
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
      truncationReason = "max_bytes";
      return;
    }
    records.push(record);
    returnedBytes += recordBytes;
    if (event.type === "match") matches += 1;
    if (matches >= input.max_matches) {
      responseTruncated = true;
      truncationReason = "max_matches";
      return;
    }
  };
  let backendBytes = 0;
  await new Promise<void>((resolveSearch, rejectSearch) => {
    const child = spawn(ripgrepExecutable(), args, { cwd: target.root_real, stdio: ["ignore", "pipe", "pipe"] });
    let pending = "";
    let stderr = "";
    let failure: unknown;
    const stop = (error?: unknown) => {
      failure ??= error;
      child.kill();
    };
    const timer = setTimeout(() => stop(new HostSpanError("DEADLINE_EXCEEDED", "Search exceeded its deadline.", true, {
      resource: "file_search", reason: "deadline_exceeded", deadline_ms: input.deadline_ms,
    })), input.deadline_ms);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 64 * 1024); });
    child.stdout.on("data", (chunk: string) => {
      if (failure || responseTruncated) return;
      backendBytes += Buffer.byteLength(chunk);
      pending += chunk;
      try {
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          consume(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          if (responseTruncated) {
            clearTimeout(timer);
            stop();
            return;
          }
          newline = pending.indexOf("\n");
        }
        // Bound a single unfinished JSON record as well as the returned records.
        if (Buffer.byteLength(pending) > input.max_bytes + 64 * 1024) {
          stop(new HostSpanError("SEARCH_SCOPE_TOO_BROAD", "Search output record exceeded max_bytes; narrow the scope.", false, {
            resource: "file_search", reason: "output_limit", limit_bytes: input.max_bytes,
            backend_limit_bytes: input.max_bytes + 64 * 1024,
          }));
        }
      } catch (error) { stop(error); }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      failure = error.code === "ENOENT"
        ? new HostSpanError("SEARCH_BACKEND_UNAVAILABLE", "ripgrep is required but not available.", true)
        : new HostSpanError("SEARCH_BACKEND_UNAVAILABLE", `ripgrep failed: ${error.message}`, true);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) return rejectSearch(failure);
      if (responseTruncated) return resolveSearch();
      if (code !== 0 && code !== 1) {
        if (/regex parse error:/i.test(stderr)) {
          return rejectSearch(new HostSpanError("VALIDATION_FAILED", "Search query is not a valid regular expression.", false, {
            resource: "file_search", reason: "invalid_regex",
          }));
        }
        if (/error parsing glob/i.test(stderr)) {
          return rejectSearch(new HostSpanError("VALIDATION_FAILED", "Search glob is invalid.", false, {
            resource: "file_search", reason: "invalid_glob",
          }));
        }
        return rejectSearch(new HostSpanError("SEARCH_BACKEND_UNAVAILABLE", `ripgrep failed: ${stderr.trim() || code}`, true));
      }
      try {
        consume(pending);
        resolveSearch();
      } catch (error) { rejectSearch(error); }
    });
  });
  const backendOutputTruncated = backendBytes > input.max_bytes;
  if (!truncationReason && backendOutputTruncated) truncationReason = "backend_output";
  return {
    matches: records,
    match_count: matches,
    returned_record_bytes: returnedBytes,
    truncated: responseTruncated || backendOutputTruncated,
    ...(truncationReason ? { truncation_reason: truncationReason } : {}),
    backend: "ripgrep",
    binary: "ignored",
    hidden: false,
  };
}
