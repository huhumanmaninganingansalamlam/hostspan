import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { fileList } from "../../src/files/list.js";
import { fileRead } from "../../src/files/read.js";
import { darwinDirentLayout } from "../../src/files/darwin-fs.js";
import { fileSearch } from "../../src/files/search.js";
import type { HostSpanError } from "../../src/errors.js";
import { TargetRegistry } from "../../src/targets/registry.js";

const cleanup: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hostspan-files-"));
  cleanup.push(root);
  const config: HostSpanConfig = {
    schema_version: 1,
    policy_epoch: 1,
    server: { listen_host: "127.0.0.1", listen_port: 39393, data_dir: join(root, ".state") },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: 1024 * 1024,
    },
    targets: {
      test: {
        label: "test",
        provider: "local",
        root,
        capabilities: ["read", "write"],
        deny_globs: ["**/.env*"],
        ignore_globs: ["**/ignored/**"],
      },
    },
    exec_profiles: {},
  };
  return { root, target: new TargetRegistry(config).get("test") };
}

afterEach(() => {
  while (cleanup.length) {
    const path = cleanup.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe("file services", () => {
  it("pins the Darwin readdir layouts used by Intel and Apple Silicon", () => {
    expect(darwinDirentLayout("x64")).toEqual({
      recordLengthOffset: 4,
      nameLengthOffset: 7,
      nameLengthType: "uint8_t",
      nameOffset: 8,
      maxNameLength: 255,
      maxRecordLength: 264,
    });
    expect(darwinDirentLayout("arm64")).toEqual({
      recordLengthOffset: 16,
      nameLengthOffset: 18,
      nameLengthType: "uint16_t",
      nameOffset: 21,
      maxNameLength: 1023,
      maxRecordLength: 1048,
    });
  });

  it("preserves UTF-8 boundaries when a byte cap cuts through a code point", () => {
    const { root, target } = fixture();
    writeFileSync(join(root, "utf8.txt"), "abc😀def\nsecond\n");
    const result = fileRead(target, { path: "utf8.txt", start_line: 1, end_line: 1, max_bytes: 5, include_sha256: true });
    expect(result).toMatchObject({ encoding: "utf-8", binary: false, text: "abc", truncated_after: true });
    expect("text" in result ? result.text : "").not.toContain("�");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("streams to a late line range instead of limiting the scan to max_bytes", () => {
    const { root, target } = fixture();
    const lines = Array.from({ length: 120 }, (_, index) => `line-${String(index + 1).padStart(3, "0")}`);
    writeFileSync(join(root, "late.txt"), `${lines.join("\n")}\n`);
    const result = fileRead(target, {
      path: "late.txt",
      start_line: 90,
      end_line: 92,
      max_bytes: 64,
      include_sha256: false,
    });
    expect(result).toMatchObject({
      binary: false,
      text: "line-090\nline-091\nline-092",
      returned_range: { start_line: 90, end_line: 92 },
      truncated_before: true,
      truncated_after: true,
    });
    if (!("returned_range" in result)) throw new Error("late range read unexpectedly returned binary metadata");
    expect(result.returned_range.bytes_scanned).toBeGreaterThan(64);
  });

  it("stops scanning once max_bytes already caps the returned range", () => {
    const { root, target } = fixture();
    writeFileSync(join(root, "long-line.txt"), Buffer.alloc(2 * 1024 * 1024, 0x78));
    const result = fileRead(target, {
      path: "long-line.txt",
      start_line: 1,
      end_line: 1,
      max_bytes: 4096,
      include_sha256: false,
    });
    expect(result).toMatchObject({
      binary: false,
      returned_range: { start_line: 1, end_line: 1, bytes_scanned: 4096 },
      truncated_before: false,
      truncated_after: true,
    });
    expect("text" in result ? Buffer.byteLength(result.text) : 0).toBe(4096);
  });

  it("fails boundedly when a requested line range would require an excessive scan", () => {
    const { root, target } = fixture();
    writeFileSync(join(root, "wide.txt"), "0123456789abcdef\n".repeat(32));
    expect(() =>
      fileRead(
        target,
        {
          path: "wide.txt",
          start_line: 20,
          end_line: 20,
          max_bytes: 64,
          include_sha256: false,
        },
        64,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<HostSpanError>>({
        code: "SCOPE_DENIED",
        details: expect.objectContaining({ reason: "file_read_scan_limit", max_scan_bytes: 64 }),
      }),
    );
  });

  it("reports BOM and decodes UTF-8, UTF-16LE, and UTF-16BE", () => {
    const { root, target } = fixture();
    writeFileSync(join(root, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\n")]));
    writeFileSync(join(root, "le.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello\n", "utf16le")]));
    const le = Buffer.from("hello\n", "utf16le");
    const be = Buffer.from(le);
    for (let i = 0; i < be.length; i += 2) {
      const first = be[i] ?? 0;
      be[i] = be[i + 1] ?? 0;
      be[i + 1] = first;
    }
    writeFileSync(join(root, "be.txt"), Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    expect(fileRead(target, { path: "bom.txt", start_line: 1, end_line: 1, max_bytes: 1024, include_sha256: false })).toMatchObject({ encoding: "utf-8", bom: true, text: "hello" });
    expect(fileRead(target, { path: "le.txt", start_line: 1, end_line: 1, max_bytes: 1024, include_sha256: false })).toMatchObject({ encoding: "utf-16le", bom: true, text: "hello" });
    expect(fileRead(target, { path: "be.txt", start_line: 1, end_line: 1, max_bytes: 1024, include_sha256: false })).toMatchObject({ encoding: "utf-16be", bom: true, text: "hello" });
  });

  it("does not split a UTF-16 surrogate pair at the byte cap", () => {
    const { root, target } = fixture();
    writeFileSync(
      join(root, "emoji-le.txt"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("😀X\n", "utf16le")]),
    );
    const short = fileRead(target, {
      path: "emoji-le.txt",
      start_line: 1,
      end_line: 1,
      max_bytes: 2,
      include_sha256: false,
    });
    expect(short).toMatchObject({ binary: false, text: "", truncated_after: true });
    expect("text" in short ? short.text : "").not.toContain("�");

    const complete = fileRead(target, {
      path: "emoji-le.txt",
      start_line: 1,
      end_line: 1,
      max_bytes: 4,
      include_sha256: false,
    });
    expect(complete).toMatchObject({ binary: false, text: "😀", truncated_after: true });
  });

  it("does not force-decode binary files", () => {
    const { root, target } = fixture();
    writeFileSync(join(root, "binary.bin"), Buffer.from([1, 2, 0, 255, 4]));
    expect(fileRead(target, { path: "binary.bin", start_line: 1, end_line: 10, max_bytes: 1024, include_sha256: false })).toMatchObject({
      binary: true,
      encoding: "binary",
      error_code: "BINARY_FILE",
    });
  });

  it("classifies invalid UTF-8 and invalid UTF-16 sequences as binary instead of hiding replacement data", () => {
    const { root, target } = fixture();
    writeFileSync(join(root, "invalid-utf8.bin"), Buffer.from([0x61, 0xff, 0x62, 0x0a]));
    writeFileSync(
      join(root, "invalid-utf16.bin"),
      Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00, 0x0a, 0x00]),
    );
    expect(
      fileRead(target, {
        path: "invalid-utf8.bin",
        start_line: 1,
        end_line: 1,
        max_bytes: 1024,
        include_sha256: false,
      }),
    ).toMatchObject({ binary: true, encoding: "binary", error_code: "BINARY_FILE" });
    expect(
      fileRead(target, {
        path: "invalid-utf16.bin",
        start_line: 1,
        end_line: 1,
        max_bytes: 1024,
        include_sha256: false,
      }),
    ).toMatchObject({ binary: true, encoding: "binary", error_code: "BINARY_FILE" });
  });

  it("lists symlinks without following them and honors bounded pagination", () => {
    const { root, target } = fixture();
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir", "a.txt"), "a");
    writeFileSync(join(root, "dir", "b.txt"), "b");
    symlinkSync(join(root, "dir", "a.txt"), join(root, "link"));
    const first = fileList(target, { path: ".", depth: 2, max_entries: 2, include_hidden: true });
    expect(first.entries).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(first.cursor).toBeTypeOf("string");
    const all = fileList(target, { path: ".", depth: 2, max_entries: 20, include_hidden: true });
    expect(all.entries).toContainEqual(expect.objectContaining({ path: "link", type: "symlink" }));
  });

  it("reports a missing list path as FILE_NOT_FOUND", () => {
    const { target } = fixture();
    expect(() => fileList(target, { path: "missing", depth: 1, max_entries: 20, include_hidden: true })).toThrowError(
      expect.objectContaining<Partial<HostSpanError>>({ code: "FILE_NOT_FOUND" }),
    );
  });

  it.runIf(process.platform === "darwin")("lists Unicode and spaced names through the pinned Darwin directory handle", () => {
    const { root, target } = fixture();
    mkdirSync(join(root, "목록"));
    writeFileSync(join(root, "목록", "한글 파일.txt"), "ok\n");
    writeFileSync(join(root, "목록", "space name.txt"), "ok\n");
    const result = fileList(target, { path: "목록", depth: 1, max_entries: 20, include_hidden: true });
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "목록/한글 파일.txt", type: "file" }),
        expect.objectContaining({ path: "목록/space name.txt", type: "file" }),
      ]),
    );
  });

  it("stops directory traversal once one page plus the truncation sentinel is collected", () => {
    const { root, target } = fixture();
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(root, `file-${String(index).padStart(2, "0")}.txt`), "x");
    }
    const first = fileList(target, { path: ".", depth: 1, max_entries: 3, include_hidden: true });
    expect(first.entries).toHaveLength(3);
    expect(first.truncated).toBe(true);
    const second = fileList(target, {
      path: ".",
      depth: 1,
      max_entries: 3,
      include_hidden: true,
      cursor: first.cursor as string,
    });
    expect(second.entries).toHaveLength(3);
    expect(second.entries).not.toEqual(first.entries);
  });

  it("returns bounded ripgrep context and excludes denied globs", async () => {
    const { root, target } = fixture();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.txt"), "before\nneedle\nafter\n");
    writeFileSync(join(root, ".env-secret"), "needle\n");
    const result = await fileSearch(target, {
      query: "needle",
      paths: ["."],
      context_before: 1,
      context_after: 1,
      max_matches: 10,
      max_bytes: 64 * 1024,
      deadline_ms: 5_000,
    });
    expect(result.match_count).toBe(1);
    expect(result.matches).toEqual(expect.arrayContaining([expect.objectContaining({ type: "match", path: "src/a.txt", text: "needle" })]));
    expect(result.matches.some((match) => match.path === ".env-secret")).toBe(false);
  });

  it("bounds search response records by max_bytes", async () => {
    const { root, target } = fixture();
    writeFileSync(join(root, "many.txt"), Array.from({ length: 20 }, () => `needle-${"x".repeat(80)}`).join("\n"));
    const result = await fileSearch(target, {
      query: "needle",
      paths: ["."],
      context_before: 0,
      context_after: 0,
      max_matches: 20,
      max_bytes: 300,
      deadline_ms: 5_000,
    });
    expect(result).toMatchObject({
      truncated: true,
      truncation_reason: "max_bytes",
    });
    expect(result.returned_record_bytes).toBeLessThanOrEqual(300);
    expect(Buffer.byteLength(JSON.stringify(result.matches), "utf8")).toBeLessThanOrEqual(320);
  });

  it("reports max_matches as the search truncation reason", async () => {
    const { root, target } = fixture();
    writeFileSync(join(root, "many-matches.txt"), Array.from({ length: 10 }, (_, index) => `needle-${index}`).join("\n"));
    const result = await fileSearch(target, {
      query: "needle",
      paths: ["."],
      context_before: 0,
      context_after: 0,
      max_matches: 2,
      max_bytes: 64 * 1024,
      deadline_ms: 5_000,
    });
    expect(result).toMatchObject({
      match_count: 2,
      truncated: true,
      truncation_reason: "max_matches",
    });
    expect(result.returned_record_bytes).toBeGreaterThan(0);
  });

  it("returns an empty result when ripgrep finds no matches", async () => {
    const { root, target } = fixture();
    writeFileSync(join(root, "a.txt"), "alpha\n");
    const result = await fileSearch(target, {
      query: "missing",
      paths: ["."],
      context_before: 0,
      context_after: 0,
      max_matches: 10,
      max_bytes: 4096,
      deadline_ms: 1000,
    });
    expect(result).toMatchObject({ match_count: 0, matches: [], truncated: false, backend: "ripgrep" });
  });

  it("reports a missing search path as FILE_NOT_FOUND", async () => {
    const { target } = fixture();
    await expect(
      fileSearch(target, {
        query: "needle",
        paths: ["missing"],
        context_before: 0,
        context_after: 0,
        max_matches: 10,
        max_bytes: 4096,
        deadline_ms: 1000,
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<HostSpanError>>({ code: "FILE_NOT_FOUND" }));
  });

  it("reports an invalid search regex as VALIDATION_FAILED", async () => {
    const { target } = fixture();
    await expect(
      fileSearch(target, {
        query: "fileList(",
        paths: ["."],
        context_before: 0,
        context_after: 0,
        max_matches: 10,
        max_bytes: 4096,
        deadline_ms: 1000,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HostSpanError>>({
        code: "VALIDATION_FAILED",
        details: expect.objectContaining({ reason: "invalid_regex" }),
      }),
    );
  });

  it("reports an invalid search glob as VALIDATION_FAILED", async () => {
    const { target } = fixture();
    await expect(
      fileSearch(target, {
        query: "needle",
        glob: "[",
        paths: ["."],
        context_before: 0,
        context_after: 0,
        max_matches: 10,
        max_bytes: 4096,
        deadline_ms: 1000,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HostSpanError>>({
        code: "VALIDATION_FAILED",
        details: expect.objectContaining({ reason: "invalid_glob" }),
      }),
    );
  });

  it("rejects match-all searches before invoking ripgrep", async () => {
    const { target } = fixture();
    await expect(
      fileSearch(target, {
        query: "",
        paths: ["."],
        context_before: 0,
        context_after: 0,
        max_matches: 10,
        max_bytes: 4096,
        deadline_ms: 1000,
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<HostSpanError>>({ code: "SEARCH_SCOPE_TOO_BROAD" }));
  });
});
