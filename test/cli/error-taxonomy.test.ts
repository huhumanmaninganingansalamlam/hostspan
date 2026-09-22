import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDaemonPid } from "../../src/cli/daemon.js";
import { main } from "../../src/cli/index.js";
import { createInitialConfig } from "../../src/config/defaults.js";
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
