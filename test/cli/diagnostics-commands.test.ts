import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli/index.js";
import { createInitialConfig } from "../../src/config/defaults.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { TOOLSET_HASH } from "../../src/mcp/registry.js";

let root = "";
let configPath = "";
let dataDir = "";
let output = "";
let restoreStdout: (() => void) | undefined;

function resetOutput(): void {
	output = "";
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hostspan-cli-diagnostics-"));
	configPath = join(root, "config.yaml");
	dataDir = join(root, "state");
	const config = createInitialConfig();
	config.server.data_dir = dataDir;
	writeConfigAtomic(configPath, config);
	resetOutput();
	const stdout = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: string | Uint8Array) => {
			output +=
				typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			return true;
		});
	restoreStdout = () => stdout.mockRestore();
});

afterEach(() => {
	restoreStdout?.();
	restoreStdout = undefined;
	rmSync(root, { recursive: true, force: true });
});

describe("diagnostics and service CLI handlers", () => {
	it("initializes one profile and preserves the existing-config validation error", async () => {
		const initializedPath = join(root, "new-profile", "config.yaml");
		expect(await main(["init", "--config", initializedPath])).toBe(0);
		expect(JSON.parse(output)).toMatchObject({
			ok: true,
			config_path: resolve(initializedPath),
			next: expect.stringContaining("hostspan targets add"),
		});
		expect(existsSync(initializedPath)).toBe(true);

		await expect(
			main(["init", "--config", initializedPath]),
		).rejects.toMatchObject({
			code: "VALIDATION_FAILED",
			message: `config already exists: ${resolve(initializedPath)}`,
		});
	});

	it("reports status and full admin snapshot without creating the state database", async () => {
		expect(await main(["status", "--verbose", "--config", configPath])).toBe(0);
		const status = JSON.parse(output) as Record<string, unknown>;
		expect(status).toMatchObject({
			toolset_hash: TOOLSET_HASH,
			daemon: { running: false },
			native_execution: true,
			sandboxed: false,
			active_process_count: 0,
		});
		expect(existsSync(join(dataDir, "state.db"))).toBe(false);

		resetOutput();
		expect(
			await main([
				"admin",
				"snapshot",
				"--recent",
				"7",
				"--config",
				configPath,
			]),
		).toBe(0);
		const snapshot = JSON.parse(output) as Record<string, unknown>;
		expect(snapshot).toMatchObject({
			daemon: { running: false },
			active_process_count: 0,
		});
		expect(existsSync(join(dataDir, "state.db"))).toBe(false);
	});

	it("exports support data to the explicit path and leaves absent logs silent", async () => {
		const exportPath = join(root, "support.json");
		expect(
			await main(["support-export", exportPath, "--config", configPath]),
		).toBe(0);
		expect(JSON.parse(output)).toEqual({ ok: true, path: resolve(exportPath) });
		expect(JSON.parse(readFileSync(exportPath, "utf8"))).toMatchObject({
			toolset_hash: TOOLSET_HASH,
		});
		expect(existsSync(join(dataDir, "state.db"))).toBe(false);

		resetOutput();
		expect(await main(["logs", "--config", configPath])).toBe(0);
		expect(output).toBe("");
	});

	it("preserves the service action validation contract without invoking systemctl", async () => {
		await expect(
			main(["service", "invalid", "--config", configPath]),
		).rejects.toMatchObject({
			code: "VALIDATION_FAILED",
			message: "service requires install|start|stop|restart|status",
		});
	});
});
