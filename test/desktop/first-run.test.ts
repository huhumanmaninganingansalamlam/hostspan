import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { HostSpanConfigSchema } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { ensureDesktopConfig, prepareDesktopConfig } from "../../src/desktop/first-run.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop first-run config", () => {
  it("keeps the last valid profile across an OS relaunch without its launch environment", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-desktop-profile-"));
    roots.push(root);
    const selected = join(root, "native-gui.yaml");
    const userData = join(root, "app");
    const legacyDir = join(root, "legacy", "hostspan");
    mkdirSync(legacyDir, { recursive: true });
    const legacy = join(legacyDir, "config.yaml");
    writeFileSync(legacy, "exec_profiles: {native-dev: {allowed_programs: [legacy]}}\n");
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "legacy"));
    vi.stubEnv("HOSTSPAN_CONFIG", selected);
    expect(prepareDesktopConfig(userData)).toBe(selected);
    const original = readFileSync(selected, "utf8");

    vi.stubEnv("HOSTSPAN_CONFIG", "");
    expect(prepareDesktopConfig(userData)).toBe(selected);
    expect(readFileSync(selected, "utf8")).toBe(original);
    expect(readFileSync(legacy, "utf8")).toContain("allowed_programs");

    vi.stubEnv("HOSTSPAN_CONFIG", legacy);
    expect(() => prepareDesktopConfig(userData)).toThrow();
    vi.stubEnv("HOSTSPAN_CONFIG", "");
    expect(prepareDesktopConfig(userData)).toBe(selected);
  });

  it("creates a valid PTY-enabled default config exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-desktop-first-run-"));
    roots.push(root);
    const configPath = join(root, "config", "config.yaml");

    expect(ensureDesktopConfig(configPath)).toEqual({ created: true, config_path: configPath });
    const first = HostSpanConfigSchema.parse(parseYaml(readFileSync(configPath, "utf8")));
    expect(first.terminal).toMatchObject({ backend: "pty", max_concurrent_sessions: 16 });
    expect(first.targets).toEqual({});
    expect(first.computer).toBeUndefined();
    expect(first.exec_profiles["native-dev"]).toMatchObject({
      mode: "native",
      max_concurrent_processes: 16,
    });

    first.targets.existing = {
      label: "Existing workspace",
      provider: "local",
      root,
      capabilities: ["read", "write", "exec"],
      exec_profile: "native-dev",
      deny_globs: [],
      ignore_globs: [],
    };
    writeConfigAtomic(configPath, first);
    const existing = HostSpanConfigSchema.parse(parseYaml(readFileSync(configPath, "utf8")));

    expect(ensureDesktopConfig(configPath)).toEqual({ created: false, config_path: configPath });
    const second = HostSpanConfigSchema.parse(parseYaml(readFileSync(configPath, "utf8")));
    expect(second).toEqual(existing);
    expect(second.targets.existing?.capabilities).toEqual(["read", "write", "exec"]);
  });
});
