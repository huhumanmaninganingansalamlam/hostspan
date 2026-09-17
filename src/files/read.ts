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

function swapUtf16(buffer: Buffer): Buffer {
  const copy = Buffer.from(buffer);
  for (let i = 0; i + 1 < copy.length; i += 2) {
    const first = copy[i] ?? 0;
    copy[i] = copy[i + 1] ?? 0;
    copy[i + 1] = first;
  }
  return copy;
}

function validUtf8Prefix(buffer: Buffer): Buffer | undefined {
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim += 1) {
    const candidate = trim === 0 ? buffer : buffer.subarray(0, buffer.length - trim);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(candidate);
      return candidate;
    } catch {
      // A valid UTF-8 stream can have at most three incomplete trailing bytes.
    }
  }
  return undefined;
}

function decode(buffer: Buffer): { text?: string; encoding: string; bom: boolean; binary: boolean; decoded_bytes: number } {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    const body = buffer.subarray(2, buffer.length - ((buffer.length - 2) % 2));
    return { text: body.toString("utf16le"), encoding: "utf-16le", bom: true, binary: false, decoded_bytes: body.length + 2 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const body = buffer.subarray(2, buffer.length - ((buffer.length - 2) % 2));
    return { text: swapUtf16(body).toString("utf16le"), encoding: "utf-16be", bom: true, binary: false, decoded_bytes: body.length + 2 };
  }
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const body = bom ? buffer.subarray(3) : buffer;
  if (body.includes(0)) return { encoding: "binary", bom: false, binary: true, decoded_bytes: 0 };
  const valid = validUtf8Prefix(body);
  if (!valid) return { encoding: "binary", bom: false, binary: true, decoded_bytes: 0 };
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(valid), encoding: "utf-8", bom, binary: false, decoded_bytes: valid.length + (bom ? 3 : 0) };
}

export function sha256File(target: TargetRuntime, path: string): string {
  const { fd } = openReadNoFollow(target, path);
  try {
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
  } finally {
    closeSync(fd);
  }
}
export function fileRead(target: TargetRuntime, input: FileReadInput) {
  const { fd, path } = openReadNoFollow(target, input.path);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new HostSpanError("FILE_NOT_FOUND", `Not a regular file: ${input.path}`);
    const readBytes = Math.min(stat.size, input.max_bytes);
    const buffer = Buffer.alloc(readBytes);
    if (readBytes) readSync(fd, buffer, 0, readBytes, 0);
    const decoded = decode(buffer);
    const metadata = {
      path: path.relative,
      encoding: decoded.encoding,
      bom: decoded.bom,
      size_bytes: stat.size,
      mtime: stat.mtime.toISOString(),
      ...(input.include_sha256 ? { sha256: sha256File(target, input.path) } : {}),
    };
    if (decoded.binary || decoded.text === undefined) {
      return { ...metadata, binary: true, error_code: "BINARY_FILE", returned_bytes: 0, truncated_before: false, truncated_after: stat.size > 0 };
    }
    const newline_style = decoded.text.includes("\r\n") ? "crlf" : decoded.text.includes("\n") ? "lf" : "none";
    const lines = decoded.text.split(/\r?\n/);
    const start = Math.max(1, input.start_line);
    const end = Math.min(input.end_line, lines.length);
    const text = lines.slice(start - 1, end).join(newline_style === "crlf" ? "\r\n" : "\n");
    return {
      ...metadata,
      binary: false,
      newline_style,
      text,
      returned_range: { start_line: start, end_line: end, bytes_scanned: decoded.decoded_bytes },
      truncated_before: start > 1,
      truncated_after: stat.size > decoded.decoded_bytes || end < lines.length,
    };
  } finally {
    closeSync(fd);
  }
}
