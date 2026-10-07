import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

const STREAMS = ["stdout", "stderr"];
const SEGMENT_BYTES = 256 * 1024;

function directory(dataDir, processId) {
  return join(dataDir, "spools", "processes", processId);
}

function segmentName(id, stream, start) {
  return `segment-${String(id).padStart(12, "0")}-${stream}-${start}.bin`;
}

function parseSegmentName(name) {
  const match = /^segment-(\d+)-(stdout|stderr)-(\d+)\.bin$/.exec(name);
  return match ? { id: Number(match[1]), stream: match[2], start: Number(match[3]) } : undefined;
}

function emptyState() {
  return { schema_version: 1, last_id: 0, sequence: 0, highwater: { stdout: 0, stderr: 0 }, segments: [] };
}

function readState(dir) {
  const path = join(dir, "index.json");
  if (!existsSync(path)) return emptyState();
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (
    parsed?.schema_version !== 1 ||
    !Number.isSafeInteger(parsed.last_id) ||
    !Number.isSafeInteger(parsed.sequence) ||
    !parsed.highwater ||
    !STREAMS.every((stream) => Number.isSafeInteger(parsed.highwater[stream]) && parsed.highwater[stream] >= 0) ||
    !Array.isArray(parsed.segments)
  ) {
    throw Object.assign(new Error("Process output spool index is invalid."), { code: "SPOOL_INDEX_INVALID" });
  }
  return parsed;
}

function replaceFile(tempPath, destination) {
  const deadline = Date.now() + (process.platform === "win32" ? 1_500 : 0);
  for (;;) {
    try {
      renameSync(tempPath, destination);
      return;
    } catch (error) {
      const code = error?.code;
      const retryable = process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(String(code)) && Date.now() < deadline;
      if (!retryable) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function persistState(dir, state) {
  const path = join(dir, "index.json");
  const temp = join(dir, `index.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  try {
    replaceFile(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function removeSegment(path) {
  const deadline = Date.now() + (process.platform === "win32" ? 1_500 : 0);
  for (;;) {
    try {
      rmSync(path, { force: true });
      return;
    } catch (error) {
      if (error?.code === "ENOENT") return;
      const retryable = process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(String(error?.code)) && Date.now() < deadline;
      if (!retryable) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function listDiskSegments(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => {
      const parsed = parseSegmentName(name);
      if (!parsed) return undefined;
      const path = join(dir, name);
      try {
        const size = statSync(path).size;
        if (size <= 0) return undefined;
        return { ...parsed, size, path };
      } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      }
    })
    .filter(Boolean);
}

function snapshotState(dir) {
  const state = readState(dir);
  const disk = listDiskSegments(dir);
  const diskById = new Map(disk.map((segment) => [segment.id, segment]));
  const segments = [];
  for (const segment of state.segments) {
    const actual = diskById.get(segment.id);
    if (!actual) continue;
    // Readers only consume the published prefix. A concurrent append is
    // visible after its index replacement, never as a mixed segment version.
    const size = Math.min(actual.size, segment.size);
    if (size > 0) segments.push({ ...segment, size, path: actual.path });
  }
  // Only the index publishes a complete append. Discovering new disk segments
  // here can expose their tail while hiding the appended prefix in an older
  // indexed segment, causing readers to skip real bytes. recover() owns crash recovery.
  const highwater = { ...state.highwater };
  for (const segment of segments) highwater[segment.stream] = Math.max(highwater[segment.stream], segment.start + segment.size);
  return { ...state, highwater, segments };
}

function atomicSegment(dir, id, stream, start, buffer) {
  const path = join(dir, segmentName(id, stream, start));
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, buffer, { mode: 0o600 });
  try {
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return path;
}

export class OutputSpoolStore {
  constructor(dataDir, processId, maxOutputBytes) {
    this.dir = directory(dataDir, processId);
    this.maxOutputBytes = Math.max(1, Math.floor(maxOutputBytes));
    this.segmentBytes = Math.min(SEGMENT_BYTES, Math.max(1, Math.floor(this.maxOutputBytes / 4)));
    this.legacy = Object.fromEntries(STREAMS.map((stream) => [stream, join(this.dir, `${stream}.bin`)]));
    this.owner = false;
  }

  recover() {
    if (this.owner) throw new Error("Output spool recovery must run once before the writer starts.");
    if (!existsSync(join(this.dir, "index.json")) && STREAMS.some((stream) => existsSync(this.legacy[stream]))) {
      throw Object.assign(new Error("Legacy output is owned by its existing process worker."), { code: "SPOOL_LEGACY_ACTIVE" });
    }
    this.owner = true;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const state = readState(this.dir);
    const disk = listDiskSegments(this.dir).sort((a, b) => a.id - b.id);
    const originalLastId = state.last_id;
    const diskById = new Map(disk.map((segment) => [segment.id, segment]));
    const known = new Set(state.segments.map((segment) => segment.id));
    let changed = false;
    for (const segment of disk) {
      if (segment.id > originalLastId && !known.has(segment.id)) {
        state.segments.push({
          id: segment.id,
          stream: segment.stream,
          start: segment.start,
          size: segment.size,
          last_sequence: state.sequence + 1,
        });
        state.last_id = Math.max(state.last_id, segment.id);
        state.highwater[segment.stream] = Math.max(state.highwater[segment.stream], segment.start + segment.size);
        changed = true;
      }
    }
    state.segments = state.segments.filter((segment) => {
      const actual = diskById.get(segment.id);
      if (!actual) {
        changed = true;
        return false;
      }
      if (actual.size > segment.size) {
        segment.size = actual.size;
        state.highwater[segment.stream] = Math.max(state.highwater[segment.stream], segment.start + actual.size);
        changed = true;
      }
      return true;
    });
    if (changed || !existsSync(join(this.dir, "index.json"))) persistState(this.dir, state);
    const retainedIds = new Set(state.segments.map((segment) => segment.id));
    for (const segment of disk) {
      if (segment.id <= state.last_id && !retainedIds.has(segment.id)) removeSegment(segment.path);
    }
    for (const name of readdirSync(this.dir)) {
      if (name.endsWith(".tmp") || name.includes(".tmp-")) rmSync(join(this.dir, name), { force: true });
    }
  }

  highWater(stream) {
    if (!existsSync(join(this.dir, "index.json")) && existsSync(this.legacy[stream])) return statSync(this.legacy[stream]).size;
    return this.readerState().highwater[stream];
  }

  readerState() {
    if (!existsSync(join(this.dir, "index.json")) && STREAMS.some((stream) => existsSync(this.legacy[stream]))) {
      const highwater = Object.fromEntries(STREAMS.map((stream) => [stream, existsSync(this.legacy[stream]) ? statSync(this.legacy[stream]).size : 0]));
      const segments = [];
      STREAMS.forEach((stream, index) => {
        const path = this.legacy[stream];
        if (!existsSync(path)) return;
        const size = statSync(path).size;
        if (size > 0) segments.push({ id: index + 1, stream, start: 0, size, last_sequence: index + 1, path });
      });
      return { ...emptyState(), highwater, segments };
    }
    return snapshotState(this.dir);
  }

  get retainedBytes() {
    if (!existsSync(this.dir)) return 0;
    if (!existsSync(join(this.dir, "index.json"))) {
      return STREAMS.reduce((sum, stream) => sum + (existsSync(this.legacy[stream]) ? statSync(this.legacy[stream]).size : 0), 0);
    }
    return this.readerState().segments.reduce((sum, segment) => sum + segment.size, 0);
  }

  append(stream, chunk) {
    if (!STREAMS.includes(stream)) throw new TypeError("Invalid process output stream.");
    if (!chunk.length) return 0;
    if (!this.owner) throw new Error("Output spool append requires an initialized writer.");
    if (STREAMS.some((name) => existsSync(this.legacy[name]))) throw Object.assign(new Error("Legacy output spool must be drained before writing segmented output."), { code: "SPOOL_LEGACY_ACTIVE" });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const before = snapshotState(this.dir);
    // highwater is a cumulative byte cursor; retained segment sizes alone are a moving window.
    const nextCursor = before.highwater[stream] + chunk.length;
    if (!Number.isSafeInteger(nextCursor)) throw Object.assign(new RangeError("Process output cursor exceeded the safe integer range."), { code: "SPOOL_CURSOR_OVERFLOW" });
    const retainedChunk = chunk.length > this.maxOutputBytes ? chunk.subarray(chunk.length - this.maxOutputBytes) : chunk;
    const start = nextCursor - retainedChunk.length;
    let state = readState(this.dir);
    state.sequence += 1;

    try {
      const current = this.readerState();
      const total = current.segments.reduce((sum, segment) => sum + segment.size, 0);
      const required = Math.max(0, total + retainedChunk.length - this.maxOutputBytes);
      if (required > 0) {
        const victims = [...current.segments].sort((a, b) => a.last_sequence - b.last_sequence || a.id - b.id);
        let freed = 0;
        const removeIds = new Set();
        for (const victim of victims) {
          if (freed >= required) break;
          removeIds.add(victim.id);
          freed += victim.size;
        }
        const kept = current.segments.filter((segment) => !removeIds.has(segment.id));
        for (const streamName of STREAMS) {
          if (!kept.some((segment) => segment.stream === streamName) && current.segments.some((segment) => segment.stream === streamName)) {
            state.highwater[streamName] = Math.max(state.highwater[streamName], current.highwater[streamName]);
          }
        }
        state.segments = kept.map(({ path, ...segment }) => segment);
        // Publish the retained ranges/high-water before deleting their files.
        persistState(this.dir, state);
        for (const victim of current.segments) {
          if (removeIds.has(victim.id)) removeSegment(victim.path);
        }
      } else {
        state = { ...current, sequence: current.sequence + 1, segments: current.segments.map(({ path, ...segment }) => segment) };
      }

      let cursor = start;
      let remaining = retainedChunk;
      let active = [...state.segments]
        .filter((segment) => segment.stream === stream && segment.start + segment.size === before.highwater[stream] && segment.size < this.segmentBytes)
        .sort((a, b) => b.last_sequence - a.last_sequence)[0];
      if (cursor !== before.highwater[stream]) active = undefined;

      while (remaining.length > 0) {
        if (!active || active.size >= this.segmentBytes || active.start + active.size !== cursor) {
          const id = state.last_id + 1;
          const bytes = remaining.subarray(0, Math.min(this.segmentBytes, remaining.length));
          atomicSegment(this.dir, id, stream, cursor, bytes);
          active = { id, stream, start: cursor, size: bytes.length, last_sequence: state.sequence };
          state.last_id = id;
          state.segments.push(active);
          remaining = remaining.subarray(bytes.length);
          cursor += bytes.length;
          state.sequence += 1;
          continue;
        }
        const count = Math.min(this.segmentBytes - active.size, remaining.length);
        const path = join(this.dir, segmentName(active.id, stream, active.start));
        const fd = openSync(path, "a");
        try {
          let written = 0;
          while (written < count) written += writeSync(fd, remaining, written, count - written);
        } finally {
          closeSync(fd);
        }
        active.size += count;
        active.last_sequence = state.sequence;
        remaining = remaining.subarray(count);
        cursor += count;
        state.sequence += 1;
      }
      state.highwater[stream] = Math.max(state.highwater[stream], nextCursor);
      persistState(this.dir, state);
      return chunk.length;
    } catch (error) {
      throw Object.assign(new Error("Process output could not be retained."), {
        code: error?.code ?? "SPOOL_WRITE_FAILED",
        stream,
        cause: error,
      });
    }
  }

  read(stream, cursor, maxBytes) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = this.readerState();
      const latest = snapshot.highwater[stream];
      const segments = snapshot.segments.filter((segment) => segment.stream === stream).sort((a, b) => a.start - b.start);
      const earliest = segments[0]?.start ?? latest;
      if (cursor > latest) return { error: "CURSOR_EXPIRED", stream, earliestCursor: earliest, latestCursor: latest };
      let start = cursor;
      if (start < earliest) start = earliest;
      if (!segments.some((segment) => start >= segment.start && start < segment.start + segment.size)) {
        const next = segments.find((segment) => segment.start >= start);
        start = next?.start ?? latest;
      }
      const parts = [];
      let position = start;
      let bytesNeeded = Math.max(0, maxBytes + 3);
      let raced = false;
      for (const segment of segments) {
        const end = segment.start + segment.size;
        if (end <= position || segment.start > position || bytesNeeded <= 0) continue;
        const count = Math.min(bytesNeeded, end - position);
        const buffer = Buffer.allocUnsafe(count);
        try {
          const fd = openSync(segment.path, "r");
          let bytes;
          try {
            bytes = readSync(fd, buffer, 0, count, position - segment.start);
          } finally {
            closeSync(fd);
          }
          if (bytes !== count) {
            raced = true;
            break;
          }
          parts.push(buffer);
          position += bytes;
          bytesNeeded -= bytes;
        } catch (error) {
          if (error?.code === "ENOENT" || (process.platform === "win32" && error?.code === "EBUSY")) {
            raced = true;
            break;
          }
          throw error;
        }
      }
      if (raced) continue;
      return {
        buffer: Buffer.concat(parts),
        cursorStart: start,
        droppedBytes: Math.max(0, start - cursor),
        earliestCursor: earliest,
        latestCursor: latest,
      };
    }
    throw Object.assign(new Error("Process output changed repeatedly while it was being read."), { code: "SPOOL_READ_RACE" });
  }

  readTail(stream, maxBytes) {
    const snapshot = this.readerState();
    const segments = snapshot.segments.filter((segment) => segment.stream === stream).sort((a, b) => a.start - b.start);
    const parts = [];
    let total = 0;
    for (let index = segments.length - 1; index >= 0 && total < maxBytes; index -= 1) {
      const segment = segments[index];
      const count = Math.min(segment.size, maxBytes - total);
      const buffer = Buffer.allocUnsafe(count);
      try {
        const fd = openSync(segment.path, "r");
        try {
          const bytes = readSync(fd, buffer, 0, count, segment.size - count);
          parts.unshift(buffer.subarray(0, bytes));
          total += bytes;
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      } finally {
        // A rolling append can remove a segment after the snapshot.
      }
    }
    return Buffer.concat(parts).subarray(-maxBytes);
  }
}

export function scanProcessSpools(dataDir) {
  const root = join(dataDir, "spools", "processes");
  const sizes = new Map();
  if (!existsSync(root)) return { total: 0, sizes };
  let total = 0;
  for (const processId of readdirSync(root)) {
    const dir = join(root, processId);
    if (!statSync(dir).isDirectory()) continue;
    let bytes = 0;
    for (const name of readdirSync(dir)) {
      if (!parseSegmentName(name) && name !== "stdout.bin" && name !== "stderr.bin") continue;
      try { bytes += statSync(join(dir, name)).size; } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    total += bytes;
    sizes.set(processId, bytes);
  }
  return { total, sizes };
}

export function processOutputActivity(dataDir, processId) {
  const dir = directory(dataDir, processId);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { output_bytes: 0, last_output_at: null };
  let bytes = 0;
  let latestMtime = 0;
  for (const name of readdirSync(dir)) {
    if (!parseSegmentName(name) && name !== "stdout.bin" && name !== "stderr.bin") continue;
    let stat;
    try { stat = statSync(join(dir, name)); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    bytes += stat.size;
    if (stat.size > 0) latestMtime = Math.max(latestMtime, stat.mtimeMs);
  }
  return { output_bytes: bytes, last_output_at: latestMtime ? new Date(latestMtime).toISOString() : null };
}

export function removeProcessSpool(dataDir, processId) {
  rmSync(directory(dataDir, processId), { recursive: true, force: true });
}

export function cleanupExpiredProcessSpools(dataDir, expiredProcessIds, maxTotalBytes, quotaCandidates = []) {
  const root = join(dataDir, "spools", "processes");
  const removed = new Set();
  const evicted = [];
  const removeArtifacts = (processId) => {
    rmSync(join(root, processId), { recursive: true, force: true });
    rmSync(join(dataDir, "sessions", processId), { recursive: true, force: true });
  };
  for (const processId of expiredProcessIds) {
    const spool = join(root, processId);
    const session = join(dataDir, "sessions", processId);
    if (!existsSync(spool) && !existsSync(session)) continue;
    removeArtifacts(processId);
    removed.add(processId);
  }
  const usage = scanProcessSpools(dataDir);
  let total = usage.total;
  for (const processId of quotaCandidates) {
    if (total <= maxTotalBytes) break;
    if (removed.has(processId)) continue;
    const bytes = usage.sizes.get(processId) ?? 0;
    if (bytes <= 0) continue;
    removeArtifacts(processId);
    usage.sizes.delete(processId);
    total = Math.max(0, total - bytes);
    evicted.push(processId);
  }
  return { removed: [...removed], evicted, total_bytes: total, over_quota: total > maxTotalBytes };
}
