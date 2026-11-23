import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { PortalDesktop } from "../../src/computer/portal.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";

vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: vi.fn(),
}));

it("fails closed on malformed desktop worker events and requires a fresh session", async () => {
	vi.stubEnv("XDG_SESSION_TYPE", "wayland");
	const db = openDatabase(":memory:");
	const worker = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
	});
	const commands: Array<Record<string, unknown>> = [];
	worker.stdin.on("data", (chunk: Buffer) =>
		commands.push(JSON.parse(chunk.toString())),
	);
	vi.mocked(spawn).mockImplementation(
		() => worker as unknown as ChildProcessWithoutNullStreams,
	);
	const desktop = new PortalDesktop(new OperationsRepo(db));
	try {
		const opened = await desktop.run({ action: "open" });
		expect(desktop.status()).toMatchObject({
			state: expect.stringMatching(/connecting|awaiting_consent/),
		});
		worker.stdout.write(
			'{"event":"permission_required","permission":"not-a-real-grant"}\n',
		);
		await Promise.resolve();
		expect(worker.kill).toHaveBeenCalledOnce();
		expect(desktop.status()).toMatchObject({
			state: "failed",
			next_action: { arguments: { action: "open" } },
		});
		expect(desktop.status()).not.toHaveProperty("session_id");
		await expect(
			desktop.run({ action: "observe", session_id: opened.session_id }),
		).rejects.toMatchObject({
			code: "INTERNAL_ERROR",
		});
		expect(commands).toHaveLength(1);
	} finally {
		desktop.dispose();
		db.close();
	}
});
