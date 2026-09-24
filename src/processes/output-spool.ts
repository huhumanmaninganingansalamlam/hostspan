import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { HostSpanError } from "../mcp/errors.js";

export type OutputStream = "stdout" | "stderr";

export interface SpoolRead {
  text: string;
  next_cursor: number;
  earliest_cursor: number;
  bytes_returned: number;
}

function streamPath(dataDir: string, processId: string, stream: OutputStream): string {
  return join(dataDir, "spools", "processes", processId, `${stream}.bin`);
}

function stripAnsi(value: string): string {
  // Keep model previews deterministic without embedding control characters in source regexes.
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27) {
      output += value[index] ?? "";
      continue;
    }
    const next = value[index + 1];
    if (next === "[") {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) break;
        index += 1;
      }
    } else if (next !== undefined) {
      index += 1;
    }
  }
  return output;
}

function utf8SafePrefixLength(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  const start = Math.max(0, buffer.length - 4);
  for (let index = buffer.length; index >= start; index -= 1) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, index));
      return index;
    } catch {
      // A valid UTF-8 code point is at most four bytes; keep an incomplete tail for the next poll.
    }
  }
  // Non-UTF-8 process output is still observable. Decode with replacement rather than stalling forever.
  return buffer.length;
}

function utf8SequenceLength(firstByte: number | undefined): number {
  if (firstByte === undefined || firstByte < 0x80) return 1;
  if ((firstByte & 0xe0) === 0xc0) return 2;
  if ((firstByte & 0xf0) === 0xe0) return 3;
  if ((firstByte & 0xf8) === 0xf0) return 4;
  return 1;
}

export class OutputSpool {
  private totalBytes = 0;

  constructor(
    private readonly dataDir: string,
    readonly processId: string,
    readonly maxOutputBytes: number,
  ) {
    const dir = join(dataDir, "spools", "processes", processId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const stream of ["stdout", "stderr"] as const) {
      const path = streamPath(dataDir, processId, stream);
      if (existsSync(path)) this.totalBytes += statSync(path).size;
    }
  }

  append(stream: OutputStream, chunk: Buffer): { written: number; limit_exceeded: boolean } {
    const remaining = Math.max(0, this.maxOutputBytes - this.totalBytes);
    const writtenBuffer = chunk.subarray(0, remaining);
    const path = streamPath(this.dataDir, this.processId, stream);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (writtenBuffer.length > 0) {
      const fd = openSync(path, "a", 0o600);
      try {
        writeSync(fd, writtenBuffer);
      } finally {
        closeSync(fd);
      }
      this.totalBytes += writtenBuffer.length;
    }
    return { written: writtenBuffer.length, limit_exceeded: writtenBuffer.length < chunk.length };
  }

  read(stream: OutputStream, cursor: number, maxBytes: number): SpoolRead {
    const path = streamPath(this.dataDir, this.processId, stream);
    if (!existsSync(path)) {
      if (cursor > 0) {
        throw new HostSpanError("CURSOR_EXPIRED", "Requested output cursor is no longer retained.", false, {
          stream,
          earliest_cursor: 0,
        });
      }
      return { text: "", next_cursor: 0, earliest_cursor: 0, bytes_returned: 0 };
    }
    const size = statSync(path).size;
    if (cursor > size) {
      throw new HostSpanError("CURSOR_EXPIRED", "Requested output cursor is beyond the retained output.", false, {
        stream,
        earliest_cursor: 0,
        latest_cursor: size,
      });
    }
    // Read up to three look-ahead bytes so a cursor cannot stall forever when
    // maxBytes lands inside a four-byte UTF-8 code point.
    const count = Math.min(maxBytes + 3, size - cursor);
    if (count <= 0) return { text: "", next_cursor: cursor, earliest_cursor: 0, bytes_returned: 0 };
    const buffer = Buffer.allocUnsafe(count);
    const fd = openSync(path, "r");
    let bytes = 0;
    try {
      bytes = readSync(fd, buffer, 0, count, cursor);
    } finally {
      closeSync(fd);
    }
    const slice = buffer.subarray(0, bytes);
    const requested = slice.subarray(0, Math.min(maxBytes, slice.length));
    let safeLength = utf8SafePrefixLength(requested);
    if (safeLength === 0 && slice.length > 0) {
      const sequenceLength = utf8SequenceLength(slice[0]);
      if (sequenceLength <= slice.length) {
        const firstCodePoint = slice.subarray(0, sequenceLength);
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(firstCodePoint);
          safeLength = sequenceLength;
        } catch {
          safeLength = Math.min(1, slice.length);
        }
      }
    }
    const safe = slice.subarray(0, safeLength);
    return {
      text: stripAnsi(new TextDecoder("utf-8", { fatal: false }).decode(safe)),
      next_cursor: cursor + safeLength,
      earliest_cursor: 0,
      bytes_returned: safeLength,
    };
  }
}

export function removeProcessSpool(dataDir: string, processId: string): void {
  rmSync(join(dataDir, "spools", "processes", processId), { recursive: true, force: true });
}

export function scanProcessSpools(dataDir: string): { total: number; sizes: Map<string, number> } {
  const root = join(dataDir, "spools", "processes");
  const sizes = new Map<string, number>();
  if (!existsSync(root)) return { total: 0, sizes };
  let total = 0;
  for (const processId of readdirSync(root)) {
    const dir = join(root, processId);
    if (!statSync(dir).isDirectory()) continue;
    let bytes = 0;
    for (const stream of ["stdout.bin", "stderr.bin"]) {
      const path = join(dir, stream);
      if (existsSync(path)) bytes += statSync(path).size;
    }
    total += bytes;
    sizes.set(processId, bytes);
  }
  return { total, sizes };
}

export function processOutputActivity(
  dataDir: string,
  processId: string,
): { output_bytes: number; last_output_at: string | null } {
  const dir = join(dataDir, "spools", "processes", processId);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { output_bytes: 0, last_output_at: null };
  let total = 0;
  let latestMtimeMs = 0;
  for (const stream of ["stdout.bin", "stderr.bin"]) {
    const path = join(dir, stream);
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    total += stat.size;
    if (stat.size > 0) latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
  }
  return {
    output_bytes: total,
    last_output_at: latestMtimeMs > 0 ? new Date(latestMtimeMs).toISOString() : null,
  };
}

export function cleanupExpiredProcessSpools(
  dataDir: string,
  expiredProcessIds: string[],
  maxTotalBytes: number,
  quotaCandidates: string[] = [],
): { removed: string[]; evicted: string[]; total_bytes: number; over_quota: boolean } {
  const root = join(dataDir, "spools", "processes");
  const removed: string[] = [];
  const evicted: string[] = [];
  const removeArtifacts = (processId: string) => {
    const path = join(root, processId);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    rmSync(join(dataDir, "sessions", processId), { recursive: true, force: true });
  };
  for (const processId of expiredProcessIds) {
    const path = join(root, processId);
    const sessionPath = join(dataDir, "sessions", processId);
    if (!existsSync(path) && !existsSync(sessionPath)) continue;
    removeArtifacts(processId);
    removed.push(processId);
  }
  const spoolUsage = scanProcessSpools(dataDir);
  let total = spoolUsage.total;
  for (const processId of quotaCandidates) {
    if (total <= maxTotalBytes) break;
    if (removed.includes(processId)) continue;
    const bytes = spoolUsage.sizes.get(processId) ?? 0;
    if (bytes <= 0) continue;
    removeArtifacts(processId);
    spoolUsage.sizes.delete(processId);
    total = Math.max(0, total - bytes);
    evicted.push(processId);
  }
  return { removed, evicted, total_bytes: total, over_quota: total > maxTotalBytes };
}
