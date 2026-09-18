import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, resolve } from "node:path";
import { statSync } from "node:fs";
import { HostSpanError } from "../mcp/errors.js";
import type { TargetRuntime } from "../targets/registry.js";
import { resolveTargetPath } from "./path-guard.js";

const execFileAsync = promisify(execFile);

interface SearchWaiter {
  resolve: () => void;
  reject: (error: HostSpanError) => void;
  timer: NodeJS.Timeout;
}

export class SearchConcurrencyLimiter {
  private active = 0;
  private readonly queue: SearchWaiter[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
    private readonly queueTimeoutMs: number,
  ) {}

  snapshot(): { active: number; queued: number; max_concurrent: number; max_queued: number } {
    return {
      active: this.active,
      queued: this.queue.length,
      max_concurrent: this.maxConcurrent,
      max_queued: this.maxQueued,
    };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    if (this.queue.length >= this.maxQueued) {
      throw this.busyError();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: SearchWaiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          this.active += 1;
          resolve();
        },
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(this.busyError());
        }, this.queueTimeoutMs),
      };
      waiter.timer.unref();
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    next?.resolve();
  }

  private busyError(): HostSpanError {
    return new HostSpanError("SERVER_BUSY", "Search capacity is saturated; retry after a short delay.", true, {
      resource: "file_search",
      active: this.active,
      queued: this.queue.length,
      max_concurrent: this.maxConcurrent,
      max_queued: this.maxQueued,
      queue_timeout_ms: this.queueTimeoutMs,
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
  const searchPaths = (input.paths.length ? input.paths : ["."]).map((path) => resolveTargetPath(target, path, "search").relative);
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
    ({ stdout } = await execFileAsync("rg", args, {
      cwd: target.root_real,
      encoding: "utf8",
      timeout: input.deadline_ms,
      maxBuffer: input.max_bytes + 64 * 1024,
    }));
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & { code?: string | number; stdout?: string };
    if (cause.code === "ENOENT") throw new HostSpanError("SEARCH_BACKEND_UNAVAILABLE", "ripgrep is required but not available.", true);
    if (cause.code === "1") stdout = cause.stdout ?? "";
    else if (cause.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new HostSpanError("SEARCH_SCOPE_TOO_BROAD", "Search output exceeded max_bytes; narrow the scope.");
    else throw new HostSpanError("SEARCH_BACKEND_UNAVAILABLE", `ripgrep failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  const records: Array<Record<string, unknown>> = [];
  let matches = 0;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line) as RipgrepEvent;
    if (!event.data || !["match", "context"].includes(event.type)) continue;
    const pathText = event.data.path?.text as string | undefined;
    if (!pathText) continue;
    const absolute = resolve(target.root_real, pathText);
    const guarded = resolveTargetPath(target, relative(target.root_real, absolute), "search");
    const stat = statSync(guarded.absolute);
    records.push({
      type: event.type,
      path: guarded.relative.replaceAll("\\", "/"),
      line_number: event.data.line_number,
      text: event.data.lines?.text?.replace(/\r?\n$/, "") ?? "",
      mtime: stat.mtime.toISOString(),
    });
    if (event.type === "match") matches += 1;
    if (matches >= input.max_matches) break;
  }
  return {
    matches: records,
    match_count: matches,
    truncated: matches >= input.max_matches || Buffer.byteLength(stdout) > input.max_bytes,
    backend: "ripgrep",
    binary: "ignored",
    hidden: false,
  };
}
