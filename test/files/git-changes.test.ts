import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { gitChanges } from "../../src/files/git-changes.js";
import { TargetRegistry } from "../../src/targets/registry.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hostspan-git-"));
  roots.push(root);
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
        capabilities: ["read", "git"],
        deny_globs: ["**/.env*"],
        ignore_globs: [],
      },
    },
    exec_profiles: {},
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "HostSpan Test",
        GIT_AUTHOR_EMAIL: "hostspan@example.invalid",
        GIT_COMMITTER_NAME: "HostSpan Test",
        GIT_COMMITTER_EMAIL: "hostspan@example.invalid",
      },
    });
  git("init", "-q");
  return { root, git, target: new TargetRegistry(config).get("test", "git") };
}

describe("git_changes", () => {
  it("resolves a requested path to a nested repository without requiring the target root to be a repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-git-parent-"));
    roots.push(root);
    const repository = join(root, "repo");
    mkdirSync(repository);
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
          capabilities: ["read", "git"],
          deny_globs: ["**/.env*"],
          ignore_globs: [],
        },
      },
      exec_profiles: {},
    };
    execFileSync("git", ["init", "-q"], { cwd: repository });
    writeFileSync(join(repository, "nested.txt"), "base\n");
    writeFileSync(join(repository, ".env"), "SECRET=nested\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    const target = new TargetRegistry(config).get("test", "git");

    const result = await gitChanges(target, ["repo"], 256 * 1024, true);

    expect(target.git_repository).toBe(false);
    expect(result.repository_path).toBe("repo");
    expect(result.status).toContainEqual(expect.objectContaining({ status: "A ", path: "nested.txt" }));
    expect(result.status.some((entry) => entry.path.includes(".env"))).toBe(false);
    expect(result.diff).toContain("+base");
    expect(result.diff).not.toContain("SECRET=nested");
  });

  it("returns staged and unstaged changes, parses rename records, and excludes denied paths", async () => {
    const { root, git, target } = fixture();
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "old.txt"), "base\n");
    writeFileSync(join(root, ".env"), "SECRET=before\n");
    writeFileSync(join(root, "nested", ".env.local"), "NESTED=before\n");
    git("add", ".");
    git("commit", "-qm", "fixture");

    git("mv", "old.txt", "new.txt");
    writeFileSync(join(root, "new.txt"), "base\nworktree\n");
    writeFileSync(join(root, ".env"), "SECRET=after\n");
    writeFileSync(join(root, "nested", ".env.local"), "NESTED=after\n");
    writeFileSync(join(root, "untracked.txt"), "new\n");

    const result = await gitChanges(target, [], 256 * 1024, true);
    expect(result.status).toContainEqual({
      status: "RM",
      path: "new.txt",
      original_path: "old.txt",
    });
    expect(result.status).toContainEqual(expect.objectContaining({ status: "??", path: "untracked.txt" }));
    expect(result.status.some((entry) => entry.path.includes(".env"))).toBe(false);
    expect(result.diff).toContain("rename from old.txt");
    expect(result.diff).toContain("rename to new.txt");
    expect(result.diff).toContain("+worktree");
    expect(result.diff).not.toContain("SECRET=after");
    expect(result.diff).not.toContain("NESTED=after");
    expect(result.diff_truncated).toBe(false);
  });

  it("bounds the combined staged and unstaged diff by bytes", async () => {
    const { root, git, target } = fixture();
    writeFileSync(join(root, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-qm", "fixture");
    writeFileSync(join(root, "a.txt"), `${"x".repeat(4096)}\n`);

    const result = await gitChanges(target, [], 256, true);
    expect(Buffer.byteLength(result.diff)).toBeLessThanOrEqual(256);
    expect(result.diff_truncated).toBe(true);
  });

  it("never returns a replacement character when the diff byte cap cuts through UTF-8", async () => {
    const { root, git, target } = fixture();
    writeFileSync(join(root, "unicode.txt"), "base\n");
    git("add", "unicode.txt");
    git("commit", "-qm", "fixture");
    writeFileSync(join(root, "unicode.txt"), "base\n😀tail\n");

    const full = await gitChanges(target, [], 64 * 1024, true);
    const emojiByte = Buffer.from(full.diff, "utf8").indexOf(Buffer.from("😀", "utf8"));
    expect(emojiByte).toBeGreaterThan(0);
    const truncated = await gitChanges(target, [], emojiByte + 2, true);
    expect(truncated.diff_truncated).toBe(true);
    expect(truncated.diff).not.toContain("�");
    expect(Buffer.byteLength(truncated.diff, "utf8")).toBeLessThanOrEqual(emojiByte + 2);
  });

  it("fails closed when Git status output exceeds its internal bound", async () => {
    const { root, target } = fixture();
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(root, `untracked-${String(index).padStart(2, "0")}-${"x".repeat(32)}.txt`), "x\n");
    }
    await expect(gitChanges(target, [], 4096, true, 128)).rejects.toMatchObject({
      code: "OUTPUT_LIMIT",
      details: { resource: "git_status", max_status_bytes: 128 },
    });
  });
  it.runIf(process.platform !== "win32")("does not execute fsmonitor or textconv helpers during read-only inspection", async () => {
    const { root, git, target } = fixture();
    const fsmonitorMarker = join(root, "fsmonitor-marker");
    const textconvMarker = join(root, "textconv-marker");
    const fsmonitorHelper = join(root, "fsmonitor-helper.sh");
    const textconvHelper = join(root, "textconv-helper.sh");
    writeFileSync(fsmonitorHelper, `#!/bin/sh\ntouch ${JSON.stringify(fsmonitorMarker)}\nprintf '0\\n'\n`);
    writeFileSync(textconvHelper, `#!/bin/sh\ntouch ${JSON.stringify(textconvMarker)}\ncat "$1"\n`);
    chmodSync(fsmonitorHelper, 0o700);
    chmodSync(textconvHelper, 0o700);

    writeFileSync(join(root, "binary.bin"), "base\n");
    git("add", "binary.bin");
    git("commit", "-qm", "fixture");
    writeFileSync(join(root, ".gitattributes"), "*.bin diff=probe\n");
    git("config", "core.fsmonitor", fsmonitorHelper);
    git("config", "diff.probe.textconv", textconvHelper);
    writeFileSync(join(root, "binary.bin"), "changed\n");

    const result = await gitChanges(target, ["binary.bin"], 64 * 1024, false);

    expect(result.status).toContainEqual(expect.objectContaining({ status: " M", path: "binary.bin" }));
    expect(existsSync(fsmonitorMarker)).toBe(false);
    expect(existsSync(textconvMarker)).toBe(false);
  });

  it("fails closed instead of executing working-tree content filters", async () => {
    const { root, git, target } = fixture();
    writeFileSync(join(root, "filtered.txt"), "base\n");
    git("add", "filtered.txt");
    git("commit", "-qm", "fixture");
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=probe\n");
    git("config", "filter.probe.clean", "hostspan-nonexistent-clean-filter");
    git("config", "filter.probe.required", "true");
    writeFileSync(join(root, "filtered.txt"), "changed\n");

    await expect(gitChanges(target, ["filtered.txt"], 64 * 1024, false)).rejects.toMatchObject({
      code: "POLICY_UNENFORCEABLE",
      details: { reason: "git_content_filter_unsafe", filtered_path_count: 1 },
    });
  });

  it("ignores inherited Git environment overrides", async () => {
    const { root, git, target } = fixture();
    writeFileSync(join(root, "a.txt"), "base\n");
    git("add", "a.txt");
    git("commit", "-qm", "fixture");
    writeFileSync(join(root, "a.txt"), "changed\n");
    const previousGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = join(root, "does-not-exist");
    try {
      const result = await gitChanges(target, ["a.txt"], 64 * 1024, false);
      expect(result.status).toContainEqual(expect.objectContaining({ status: " M", path: "a.txt" }));
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
    }
  });

  it.runIf(process.platform !== "win32")("treats Git-looking pathspecs as literal target paths", async () => {
    const { root, git, target } = fixture();
    const path = ":(glob)*.txt";
    writeFileSync(join(root, path), "base\n");
    execFileSync("git", ["--literal-pathspecs", "add", "--", path], { cwd: root });
    git("commit", "-qm", "fixture");
    writeFileSync(join(root, path), "changed\n");

    const result = await gitChanges(target, [path], 64 * 1024, false);

    expect(result.status).toContainEqual(expect.objectContaining({ status: " M", path }));
    expect(result.diff).toContain("+changed");
  });

});
