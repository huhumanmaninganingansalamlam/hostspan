import { closeSync, fstatSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { HostSpanError } from "../mcp/errors.js";
import type { TargetRuntime } from "../targets/registry.js";
import { openReadNoFollow } from "./path-guard.js";

export interface FileReadInput {
  path: string;
  start_line: number;
  end_line: number;
  max_bytes: number;
  include_sha256: boolean;
}

const FILE_READ_SCAN_LIMIT_BYTES = 64 * 1024 * 1024;

function swapUtf16(buffer: Buffer): Buffer {
  const copy = Buffer.from(buffer);
  for (let i = 0; i + 1 < copy.length; i += 2) {
    const first = copy[i] ?? 0;
    copy[i] = copy[i + 1] ?? 0;
    copy[i + 1] = first;
  }
  return copy;
}

function utf8SequenceLength(firstByte: number): number {
  if (firstByte >= 0xc2 && firstByte <= 0xdf) return 2;
  if (firstByte >= 0xe0 && firstByte <= 0xef) return 3;
  if (firstByte >= 0xf0 && firstByte <= 0xf4) return 4;
  return 0;
}

function validUtf8Prefix(buffer: Buffer): Buffer | undefined {
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim += 1) {
    const candidate = trim === 0 ? buffer : buffer.subarray(0, buffer.length - trim);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(candidate);
    } catch {
      continue;
    }
    if (trim === 0) return candidate;
    const tail = buffer.subarray(candidate.length);
    const expected = tail.length > 0 ? utf8SequenceLength(tail[0] ?? 0) : 0;
    if (expected <= tail.length || expected === 0) continue;
    if ([...tail.subarray(1)].every((byte) => (byte & 0xc0) === 0x80)) return candidate;
  }
  return undefined;
}

function validUtf16Prefix(buffer: Buffer, encoding: "utf-16le" | "utf-16be"): Buffer | undefined {
  const even = buffer.subarray(0, buffer.length - (buffer.length % 2));
  const readCodeUnit = (offset: number) =>
    encoding === "utf-16le" ? even.readUInt16LE(offset) : even.readUInt16BE(offset);
  for (let offset = 0; offset < even.length; offset += 2) {
    const value = readCodeUnit(offset);
    if (value >= 0xd800 && value <= 0xdbff) {
      if (offset + 2 >= even.length) return even.subarray(0, offset);
      const next = readCodeUnit(offset + 2);
      if (next < 0xdc00 || next > 0xdfff) return undefined;
      offset += 2;
      continue;
    }
    if (value >= 0xdc00 && value <= 0xdfff) return undefined;
  }
  return even;
}

function sha256Fd(fd: number): string {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  for (;;) {
    const bytes = readSync(fd, chunk, 0, chunk.length, offset);
    if (!bytes) break;
    hash.update(chunk.subarray(0, bytes));
    offset += bytes;
  }
  return hash.digest("hex");
}

type TextEncoding = "utf-8" | "utf-16le" | "utf-16be";

function detectTextEncoding(fd: number, size: number): { encoding: TextEncoding; bom: boolean; dataStart: number } {
  const prefix = Buffer.alloc(Math.min(3, size));
  if (prefix.length) readSync(fd, prefix, 0, prefix.length, 0);
  if (prefix.length >= 2 && prefix[0] === 0xff && prefix[1] === 0xfe) {
    return { encoding: "utf-16le", bom: true, dataStart: 2 };
  }
  if (prefix.length >= 2 && prefix[0] === 0xfe && prefix[1] === 0xff) {
    return { encoding: "utf-16be", bom: true, dataStart: 2 };
  }
  const bom = prefix.length >= 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf;
  return { encoding: "utf-8", bom, dataStart: bom ? 3 : 0 };
}

function scanLineRange(
  fd: number,
  size: number,
  encoding: TextEncoding,
  dataStart: number,
  startLine: number,
  endLine: number,
  scanLimitBytes: number,
): { start: number | null; end: number; scanned: number; binary: boolean; endedOnNewline: boolean } {
  let line = 1;
  let rangeStart: number | null = startLine === 1 ? dataStart : null;
  let rangeEnd: number | undefined;
  let position = dataStart;
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const width = encoding === "utf-8" ? 1 : 2;

  while (position < size && rangeEnd === undefined) {
    if (position - dataStart >= scanLimitBytes) {
      throw new HostSpanError(
        "SCOPE_DENIED",
        "file_read scan exceeded the bounded 64 MiB line-search window; narrow the location with file_search or request a smaller file.",
        false,
        { reason: "file_read_scan_limit", max_scan_bytes: scanLimitBytes, scanned_bytes: position - dataStart },
      );
    }
    let requested = Math.min(chunk.length, size - position, scanLimitBytes - (position - dataStart));
    if (width === 2 && requested % 2 !== 0 && position + requested < size) requested -= 1;
    if (requested <= 0) break;
    const bytes = readSync(fd, chunk, 0, requested, position);
    if (!bytes) break;
    const usable = width === 2 ? bytes - (bytes % 2) : bytes;
    for (let index = 0; index < usable; index += width) {
      if (encoding === "utf-8" && chunk[index] === 0) {
        return { start: rangeStart, end: position + index, scanned: position + index + 1, binary: true, endedOnNewline: false };
      }
      const newline =
        encoding === "utf-8"
          ? chunk[index] === 0x0a
          : encoding === "utf-16le"
            ? chunk[index] === 0x0a && chunk[index + 1] === 0x00
            : chunk[index] === 0x00 && chunk[index + 1] === 0x0a;
      if (!newline) continue;
      const afterNewline = position + index + width;
      if (line === endLine) {
        rangeEnd = afterNewline;
        break;
      }
      line += 1;
      if (line === startLine && rangeStart === null) rangeStart = afterNewline;
    }
    position += bytes;
  }

  return {
    start: rangeStart,
    end: rangeEnd ?? size,
    scanned: Math.min(size, position),
    binary: false,
    endedOnNewline: rangeEnd !== undefined,
  };
}

function decodeRange(buffer: Buffer, encoding: TextEncoding): string {
  if (encoding === "utf-16le") return buffer.toString("utf16le");
  if (encoding === "utf-16be") return swapUtf16(buffer).toString("utf16le");
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

export function sha256File(target: TargetRuntime, path: string): string {
  const { fd } = openReadNoFollow(target, path);
  try {
    return sha256Fd(fd);
  } finally {
    closeSync(fd);
  }
}
export function fileRead(target: TargetRuntime, input: FileReadInput, scanLimitBytes = FILE_READ_SCAN_LIMIT_BYTES) {
  const { fd, path } = openReadNoFollow(target, input.path);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new HostSpanError("FILE_NOT_FOUND", `Not a regular file: ${input.path}`);
    const detected = detectTextEncoding(fd, stat.size);
    const range = scanLineRange(fd, stat.size, detected.encoding, detected.dataStart, input.start_line, input.end_line, scanLimitBytes);
    const metadata = {
      path: path.relative,
      encoding: range.binary ? "binary" : detected.encoding,
      bom: range.binary ? false : detected.bom,
      size_bytes: stat.size,
      mtime: stat.mtime.toISOString(),
      ...(input.include_sha256 ? { sha256: sha256Fd(fd) } : {}),
    };
    if (range.binary) {
      return { ...metadata, binary: true, error_code: "BINARY_FILE", returned_bytes: 0, truncated_before: false, truncated_after: stat.size > 0 };
    }
    if (range.start === null || range.start > range.end) {
      return {
        ...metadata,
        binary: false,
        newline_style: "none",
        text: "",
        returned_range: { start_line: input.start_line, end_line: input.start_line - 1, bytes_scanned: range.scanned },
        truncated_before: input.start_line > 1,
        truncated_after: false,
      };
    }

    const available = Math.max(0, range.end - range.start);
    let returnBytes = Math.min(available, input.max_bytes);
    if (detected.encoding !== "utf-8") returnBytes -= returnBytes % 2;
    const buffer = Buffer.alloc(returnBytes);
    if (returnBytes) readSync(fd, buffer, 0, returnBytes, range.start);
    const safeBuffer =
      detected.encoding === "utf-8"
        ? validUtf8Prefix(buffer)
        : validUtf16Prefix(buffer, detected.encoding);
    if (safeBuffer === undefined) {
      return {
        ...metadata,
        encoding: "binary",
        bom: false,
        binary: true,
        error_code: "BINARY_FILE",
        returned_bytes: 0,
        truncated_before: input.start_line > 1,
        truncated_after: range.end < stat.size || available > 0,
      };
    }
    let text = decodeRange(safeBuffer, detected.encoding);
    if (safeBuffer.length === available && range.endedOnNewline) {
      if (text.endsWith("\r\n")) text = text.slice(0, -2);
      else if (text.endsWith("\n")) text = text.slice(0, -1);
    }
    const newline_style = text.includes("\r\n") ? "crlf" : text.includes("\n") ? "lf" : "none";
    const completeLines = text.length === 0 ? 0 : text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
    const returnedEndLine = completeLines > 0 ? input.start_line + completeLines - 1 : input.start_line - 1;
    return {
      ...metadata,
      binary: false,
      newline_style,
      text,
      returned_range: { start_line: input.start_line, end_line: returnedEndLine, bytes_scanned: range.scanned },
      truncated_before: input.start_line > 1,
      truncated_after: safeBuffer.length < available || range.end < stat.size,
    };
  } finally {
    closeSync(fd);
  }
}
