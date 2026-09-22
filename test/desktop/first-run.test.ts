import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { HostSpanConfigSchema } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { ensureDesktopConfig } from "../../src/desktop/first-run.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop first-run config", () => {
  it("creates a valid PTY-enabled default config exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-desktop-first-run-"));
    roots.push(root);
    const configPath = join(root, "config", "config.yaml");

    expect(ensureDesktopConfig(configPath)).toEqual({ created: true, config_path: configPath });
    const first = HostSpanConfigSchema.parse(parseYaml(readFileSync(configPath, "utf8")));
    expect(first.terminal).toMatchObject({ backend: "pty", max_concurrent_sessions: 16 });
    expect(first.server).toMatchObject({
      max_concurrent_git_changes: 4,
      max_queued_git_changes: 8,
      git_queue_timeout_ms: 1_000,
    });
    expect(first.targets).toEqual({});

    first.targets.existing = {
      label: "Existing workspace",
      provider: "local",
      root,
      capabilities: ["read", "write", "exec", "git"],
      exec_profile: "native-dev",
      deny_globs: [],
      ignore_globs: [],
    };
    writeConfigAtomic(configPath, first);
    const existing = HostSpanConfigSchema.parse(parseYaml(readFileSync(configPath, "utf8")));

    expect(ensureDesktopConfig(configPath)).toEqual({ created: false, config_path: configPath });
    const second = HostSpanConfigSchema.parse(parseYaml(readFileSync(configPath, "utf8")));
    expect(second).toEqual(existing);
    expect(second.targets.existing?.capabilities).toEqual(["read", "write", "exec", "git"]);
  });
});
