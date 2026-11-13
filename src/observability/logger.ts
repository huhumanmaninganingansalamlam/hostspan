import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import pino, { type Logger } from "pino";
import { redact } from "./redactor.js";

interface RotatingDestinationOptions {
  maxFileBytes: number;
  maxArchives: number;
}

class RotatingSyncDestination {
  private size: number;

  constructor(
    private readonly path: string,
    private readonly options: RotatingDestinationOptions,
  ) {
    // Apply smaller release limits to existing installations immediately.
    // Preserve the newest complete JSONL lines, not unbounded old archives.
    const base = basename(path);
    for (const name of readdirSync(dirname(path))) {
      if (!name.startsWith(base) || !/^\.\d+$/.test(name.slice(base.length))) continue;
      const index = Number(name.slice(base.length + 1));
      if (index > options.maxArchives) rmSync(join(dirname(path), name), { force: true });
    }
    const compact = (file: string) => {
      if (!existsSync(file) || statSync(file).size <= options.maxFileBytes) return;
      const size = statSync(file).size;
      const bytes = Buffer.allocUnsafe(options.maxFileBytes);
      const fd = openSync(file, "r");
      try {
        readSync(fd, bytes, 0, bytes.length, size - bytes.length);
      } finally {
        closeSync(fd);
      }
      const boundary = bytes.indexOf(10); // Keep only newline-delimited complete events.
      writeFileSync(file, boundary < 0 ? "" : bytes.subarray(boundary + 1), { mode: 0o600 });
    };
    compact(path);
    for (let n = 1; n <= options.maxArchives; n++) compact(`${path}.${n}`);
    this.size = existsSync(path) ? statSync(path).size : 0;
  }

  write(message: string): void {
    let bytes = Buffer.byteLength(message);
    if (bytes > this.options.maxFileBytes) {
      // Even one oversized event must not bypass the on-disk cap.
      // Never retain caller data in the replacement diagnostic record.
      message = [JSON.stringify({
        level: 40, time: Date.now(), event: "log.entry_oversized", original_bytes: bytes,
      }), ""].join("\n");
      bytes = Buffer.byteLength(message);
      if (bytes > this.options.maxFileBytes) throw new Error("Log file limit is too small for a diagnostic record.");
    }
    if (this.size > 0 && this.size + bytes > this.options.maxFileBytes) this.rotate();
    appendFileSync(this.path, message, { encoding: "utf8", mode: 0o600 });
    this.size += bytes;
  }

  private rotate(): void {
    const { maxArchives } = this.options;
    if (maxArchives <= 0) {
      rmSync(this.path, { force: true });
      this.size = 0;
      return;
    }
    rmSync(`${this.path}.${maxArchives}`, { force: true });
    for (let index = maxArchives - 1; index >= 1; index -= 1) {
      const from = `${this.path}.${index}`;
      if (existsSync(from)) renameSync(from, `${this.path}.${index + 1}`);
    }
    if (existsSync(this.path)) renameSync(this.path, `${this.path}.1`);
    this.size = 0;
  }
}

export class HostSpanLogger {
  readonly log: Logger;
  readonly audit: Logger;

  constructor(
    dataDir: string,
    options: Partial<RotatingDestinationOptions> = {},
  ) {
    const logDir = join(dataDir, "logs");
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const rotation = {
      maxFileBytes: options.maxFileBytes ?? 1024 * 1024,
      maxArchives: options.maxArchives ?? 0,
    };
    this.log = pino({}, new RotatingSyncDestination(join(logDir, "hostspan.jsonl"), rotation));
    this.audit = pino({}, new RotatingSyncDestination(join(logDir, "audit.jsonl"), rotation));
  }

  info(event: string, metadata: Record<string, unknown> = {}): void {
    this.log.info(redact({ event, ...metadata }));
  }

  auditEvent(event: string, metadata: Record<string, unknown> = {}): void {
    this.audit.info(redact({ event, ...metadata }));
  }
}
