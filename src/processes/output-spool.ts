import { HostSpanError } from "../errors.js";
import { OutputSpoolStore } from "./output-spool-store.mjs";

export {
  cleanupExpiredProcessSpools,
  processOutputActivity,
  removeProcessSpool,
  scanProcessSpools,
} from "./output-spool-store.mjs";

export type OutputStream = "stdout" | "stderr";

export interface SpoolRead {
  text: string;
  next_cursor: number;
  earliest_cursor: number;
  bytes_returned: number;
  dropped_bytes: number;
}

function stripAnsi(value: string): string {
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
      // Keep an incomplete UTF-8 tail for the next poll.
    }
  }
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
  private readonly store: InstanceType<typeof OutputSpoolStore>;
  private writerReady = false;

  constructor(dataDir: string, readonly processId: string, readonly maxOutputBytes: number) {
    this.store = new OutputSpoolStore(dataDir, processId, maxOutputBytes);
  }

  get retainedBytes(): number {
    return this.store.retainedBytes;
  }

  highWater(stream: OutputStream): number {
    return this.store.highWater(stream);
  }

  append(stream: OutputStream, chunk: Buffer): number {
    if (!this.writerReady) {
      this.store.recover();
      this.writerReady = true;
    }
    return this.store.append(stream, chunk);
  }

  read(stream: OutputStream, cursor: number, maxBytes: number): SpoolRead {
    const result = this.store.read(stream, cursor, maxBytes);
    if (result.error) {
      throw new HostSpanError("CURSOR_EXPIRED", "Requested process output cursor is outside the available output range.", false, {
        stream,
        earliest_cursor: result.earliestCursor,
        latest_cursor: result.latestCursor,
      });
    }
    if (!result.buffer || result.droppedBytes === undefined || result.earliestCursor === undefined || result.cursorStart === undefined) {
      throw new Error("Process output spool returned an invalid read result.");
    }
    const raw: Buffer = result.buffer;
    let leadingBytes = 0;
    if (result.droppedBytes > 0) {
      while (leadingBytes < Math.min(3, raw.length) && ((raw[leadingBytes] ?? 0) & 0xc0) === 0x80) leadingBytes += 1;
    }
    const buffer = raw.subarray(leadingBytes);
    const requested = buffer.subarray(0, Math.min(maxBytes, buffer.length));
    let safeLength = utf8SafePrefixLength(requested);
    if (safeLength === 0 && buffer.length > 0) {
      const sequenceLength = utf8SequenceLength(buffer[0]);
      if (sequenceLength <= buffer.length) {
        const firstCodePoint = buffer.subarray(0, sequenceLength);
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(firstCodePoint);
          safeLength = sequenceLength;
        } catch {
          safeLength = Math.min(1, buffer.length);
        }
      }
    }
    const safe = buffer.subarray(0, safeLength);
    return {
      text: stripAnsi(new TextDecoder("utf-8", { fatal: false }).decode(safe)),
      next_cursor: result.cursorStart + leadingBytes + safeLength,
      earliest_cursor: result.earliestCursor,
      bytes_returned: safeLength,
      dropped_bytes: result.droppedBytes + leadingBytes,
    };
  }
}
