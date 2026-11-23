import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli/index.js";
import { createInitialConfig } from "../../src/config/defaults.js";
import { writeConfigAtomic } from "../../src/config/writer.js";

let root = "";
let configPath = "";
let output = "";
let restoreStdout: (() => void) | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hostspan-cli-local-"));
	configPath = join(root, "config.yaml");
	const config = createInitialConfig();
	config.server.data_dir = join(root, "state");
	writeConfigAtomic(configPath, config);
	output = "";
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

describe("local CLI command handlers", () => {
	it("reports daemon, terminal, and policy state without starting runtime work", async () => {
		expect(await main(["daemon", "status", "--config", configPath])).toBe(0);
		expect(JSON.parse(output)).toMatchObject({ running: false, pid: null });

		output = "";
		expect(await main(["terminal", "list", "--config", configPath])).toBe(0);
		expect(JSON.parse(output)).toMatchObject({ sessions: [] });

		output = "";
		expect(await main(["policy", "validate", "--config", configPath])).toBe(0);
		expect(JSON.parse(output)).toMatchObject({
			ok: true,
			native_execution: true,
			sandboxed: false,
		});
	});

	it("preserves validation and unknown-command failures for invalid local actions", async () => {
		await expect(
			main(["daemon", "invalid", "--config", configPath]),
		).rejects.toMatchObject({
			code: "VALIDATION_FAILED",
			message: "daemon requires start, stop, or status",
		});
		await expect(
			main(["terminal", "invalid", "--config", configPath]),
		).rejects.toMatchObject({
			code: "VALIDATION_FAILED",
			message: "terminal requires list or attach",
		});
		await expect(
			main(["policy", "invalid", "--config", configPath]),
		).rejects.toMatchObject({
			code: "VALIDATION_FAILED",
			details: { reason: "unknown_command", command: "policy" },
		});
	});
});
