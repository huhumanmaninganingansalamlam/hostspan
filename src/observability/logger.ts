import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
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
    this.size = existsSync(path) ? statSync(path).size : 0;
  }

  write(message: string): void {
    const bytes = Buffer.byteLength(message);
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
      maxFileBytes: options.maxFileBytes ?? 16 * 1024 * 1024,
      maxArchives: options.maxArchives ?? 3,
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
