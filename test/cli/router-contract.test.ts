import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli/index.js";
import {
	PROTOCOL_VERSION,
	SERVER_VERSION,
	TOOLSET_VERSION,
} from "../../src/version.js";

let output = "";
let restoreStdout: (() => void) | undefined;

beforeEach(() => {
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
});

describe("CLI root router contract", () => {
	it("prints the established help command families and exits successfully", async () => {
		expect(await main(["--help"])).toBe(0);
		const help = output;
		expect(help).toContain(`HostSpan ${SERVER_VERSION}`);
		expect(help).toContain("process list --target TARGET");
		expect(help).toContain("access token create --name CLIENT");
		expect(help).toContain("service install|start|stop|restart|status");
	});

	it("preserves plain and verbose version output", async () => {
		expect(await main(["--version"])).toBe(0);
		expect(output).toBe(`${SERVER_VERSION}\n`);

		output = "";
		expect(await main(["version", "--verbose"])).toBe(0);
		const verbose = JSON.parse(output) as Record<string, unknown>;
		expect(verbose).toMatchObject({
			server_version: SERVER_VERSION,
			protocol_version: PROTOCOL_VERSION,
			toolset_version: TOOLSET_VERSION,
		});
		expect(verbose).toHaveProperty("toolset_hash");
		expect(verbose).toHaveProperty("build");
	});

	it("keeps unknown command errors typed and correlated to the original command", async () => {
		await expect(main(["not-a-command"])).rejects.toMatchObject({
			code: "VALIDATION_FAILED",
			details: { reason: "unknown_command", command: "not-a-command" },
		});
	});
});
