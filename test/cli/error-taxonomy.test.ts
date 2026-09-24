import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writeDaemonPid } from "../../src/cli/daemon.js";
import { createRuntime, main } from "../../src/cli/index.js";
import { runSmoke } from "../../src/cli/smoke.js";
import { createInitialConfig } from "../../src/config/defaults.js";
import { loadConfig } from "../../src/config/loader.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import type { HostSpanError } from "../../src/mcp/errors.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function configFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "hostspan-cli-errors-"));
  roots.push(root);
  const config = createInitialConfig();
  config.server.data_dir = join(root, "data");
  const configPath = join(root, "config.yaml");
  writeConfigAtomic(configPath, config);
  return configPath;
}

describe("CLI error taxonomy", () => {
  it.each([
    [["daemon"], "daemon requires start, stop, or status"],
    [["smoke"], "smoke requires --target TARGET"],
    [["not-a-command"], "unknown command: not-a-command"],
  ])("classifies CLI usage errors as VALIDATION_FAILED: %j", async (argv, message) => {
    await expect(main(argv as string[])).rejects.toEqual(
      expect.objectContaining<Partial<HostSpanError>>({
        code: "VALIDATION_FAILED",
        message,
      }),
    );
  });

  it("classifies smoke while the daemon is running as a validation precondition", async () => {
    const configPath = configFixture();
    writeDaemonPid(configPath);

    await expect(main(["smoke", "--target", "work", "--config", configPath])).rejects.toEqual(
      expect.objectContaining<Partial<HostSpanError>>({
        code: "VALIDATION_FAILED",
        details: expect.objectContaining({ reason: "daemon_running" }),
      }),
    );
  });

  it("classifies a missing target separately from malformed CLI input", async () => {
    const configPath = configFixture();

    await expect(main(["targets", "remove", "--id", "missing", "--config", configPath])).rejects.toEqual(
      expect.objectContaining<Partial<HostSpanError>>({
        code: "TARGET_NOT_FOUND",
        details: expect.objectContaining({ target_id: "missing" }),
      }),
    );
  });

  it("classifies non-interactive terminal attach attempts explicitly", async () => {
    await expect(main(["terminal", "attach", "--process", "missing"])).rejects.toEqual(
      expect.objectContaining<Partial<HostSpanError>>({
        code: "TERMINAL_NOT_INTERACTIVE",
      }),
    );
  });
});

describe("CLI target workspace defaults", () => {
  it("defaults to read only while preserving explicit capability selection", async () => {
    const configPath = configFixture();
    const defaultRoot = mkdtempSync(join(tmpdir(), "hostspan-cli-target-default-"));
    const explicitRoot = mkdtempSync(join(tmpdir(), "hostspan-cli-target-explicit-"));
    roots.push(defaultRoot, explicitRoot);

    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      expect(
        await main(["targets", "add", "--id", "default-read", "--root", defaultRoot, "--config", configPath]),
      ).toBe(0);
      expect(
        await main([
          "targets",
          "add",
          "--id",
          "explicit-dev",
          "--root",
          explicitRoot,
          "--capabilities",
          "read,write,exec",
          "--config",
          configPath,
        ]),
      ).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }

    const config = loadConfig(configPath);
    expect(config.targets["default-read"]?.capabilities).toEqual(["read"]);
    expect(config.targets["default-read"]?.exec_profile).toBeUndefined();
    expect(config.targets["explicit-dev"]?.capabilities).toEqual(["read", "write", "exec"]);
    expect(config.targets["explicit-dev"]?.exec_profile).toBe("native-dev");
    expect(config.exec_profiles["native-dev"]?.mode).toBe("native");

    const runtime = createRuntime(configPath);
    try {
      const smoke = await runSmoke(runtime, "explicit-dev");
      expect(smoke.ok, JSON.stringify(smoke.steps)).toBe(true);
      expect(smoke.steps.find((step) => step.name === "short_process")?.status).toBe("pass");
      expect(smoke.steps.find((step) => step.name === "long_process_cancel")?.status).toBe("pass");
    } finally {
      await runtime.close();
    }
  });

  it("loads old exec profile fields without retaining or enforcing them", async () => {
    const configPath = configFixture();
    const oldConfig = parseYaml(readFileSync(configPath, "utf8"));
    Object.assign(oldConfig.exec_profiles["native-dev"], {
      policy: "restricted",
      allowed_programs: ["node"],
      env_allowlist: ["CI"],
    });
    writeFileSync(configPath, stringifyYaml(oldConfig));
    expect(loadConfig(configPath).exec_profiles["native-dev"]).toMatchObject({ mode: "native" });

    const automaticRoot = mkdtempSync(join(tmpdir(), "hostspan-cli-target-legacy-auto-"));
    roots.push(automaticRoot);
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      expect(
        await main([
          "targets", "add", "--id", "legacy-auto", "--root", automaticRoot,
          "--capabilities", "read,exec", "--config", configPath,
        ]),
      ).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }

    const updated = loadConfig(configPath);
    expect(updated.targets["legacy-auto"]?.exec_profile).toBe("native-dev");
    expect(Object.keys(updated.exec_profiles)).toEqual(["native-dev"]);
    expect(readFileSync(configPath, "utf8")).not.toMatch(/policy: restricted|allowed_programs:|env_allowlist:/);
  });
});
