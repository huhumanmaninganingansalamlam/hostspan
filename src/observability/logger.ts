import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import { redact } from "./redactor.js";

export class HostSpanLogger {
  readonly log: Logger;
  readonly audit: Logger;

  constructor(dataDir: string) {
    const logDir = join(dataDir, "logs");
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    this.log = pino({}, pino.destination({ dest: join(logDir, "hostspan.jsonl"), sync: true, mkdir: true }));
    this.audit = pino({}, pino.destination({ dest: join(logDir, "audit.jsonl"), sync: true, mkdir: true }));
  }

  info(event: string, metadata: Record<string, unknown> = {}): void {
    this.log.info(redact({ event, ...metadata }));
  }

  auditEvent(event: string, metadata: Record<string, unknown> = {}): void {
    this.audit.info(redact({ event, ...metadata }));
  }
}
