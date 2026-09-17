import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { fileList } from "../../src/files/list.js";
import { fileRead } from "../../src/files/read.js";
import { fileSearch } from "../../src/files/search.js";
import type { HostSpanError } from "../../src/mcp/errors.js";
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
  it("preserves UTF-8 boundaries when a byte cap cuts through a code point", () => {
    const { root, target } = fixture();
    writeFileSync(join(root, "utf8.txt"), "abc😀def\nsecond\n");
    const result = fileRead(target, { path: "utf8.txt", start_line: 1, end_line: 1, max_bytes: 5, include_sha256: true });
    expect(result).toMatchObject({ encoding: "utf-8", binary: false, text: "abc", truncated_after: true });
    expect("text" in result ? result.text : "").not.toContain("�");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
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

  it("does not force-decode binary files", () => {
    const { root, target } = fixture();
    writeFileSync(join(root, "binary.bin"), Buffer.from([1, 2, 0, 255, 4]));
    expect(fileRead(target, { path: "binary.bin", start_line: 1, end_line: 10, max_bytes: 1024, include_sha256: false })).toMatchObject({
      binary: true,
      encoding: "binary",
      error_code: "BINARY_FILE",
    });
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
