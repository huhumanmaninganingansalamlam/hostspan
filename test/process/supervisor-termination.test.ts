import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { InteractiveSessionManager } from "../../src/processes/interactive-session.js";
import { processGroupAlive } from "../../src/processes/recovery.js";
import {
	ProcessSupervisorTestContext,
	processStartInput,
} from "../helpers/process-supervisor-fixture.js";

const processFixtures = new ProcessSupervisorTestContext();

afterEach(async () => {
	await processFixtures.dispose();
});

describe("process supervisor admission and termination", () => {
	it("replays a proven pre-dispatch write failure without delivering input", async () => {
		const failure = new Error("output unavailable before dispatch");
		const terminal = {
			outputBytes: vi.fn(() => {
				throw failure;
			}),
			write: vi.fn(),
		} as unknown as InteractiveSessionManager;
		const { supervisor, processes, operations } =
			processFixtures.createProcessSupervisorFixture({ terminal });
		processes.create({
			process_id: "preflight",
			idempotency_key: uuidv7(),
			target_id: "test",
			argv_digest: "sha256:test",
			cwd_relative: ".",
			backend: "pty",
			backend_ref: "session",
		});
		processes.markRunning("preflight", null, null);
		const input = {
			process_id: "preflight",
			idempotency_key: uuidv7(),
			chars: "once",
			control_keys: [],
			stdout_cursor: 0,
			max_bytes: 1024,
			wait_ms: 0,
		};
		await expect(supervisor.write(input)).rejects.toThrow(failure.message);
		expect(
			operations.resolve(input.idempotency_key, "process_write", input, "test"),
		).toMatchObject({
			kind: "replay",
			state: "failed",
			result: { input_delivered: false },
		});
		await expect(supervisor.write(input)).rejects.toThrow(failure.message);
		expect(terminal.write).not.toHaveBeenCalled();
	});

	it("retains confirmed cancellation when final output observation fails", async () => {
		const terminal = {
			close: vi.fn(async () => {}),
			waitForExitStatus: vi.fn(async () => ({
				exists: true,
				dead: true,
				exit_code: 0,
				signal: null,
			})),
			waitForOutputDrain: vi.fn(async () => {
				throw new Error("output unavailable after termination");
			}),
			humanAttachCommand: () => "attach",
		} as unknown as InteractiveSessionManager;
		const { supervisor, processes, operations } =
			processFixtures.createProcessSupervisorFixture({ terminal });
		processes.create({
			process_id: "cancelled",
			idempotency_key: uuidv7(),
			target_id: "test",
			argv_digest: "sha256:test",
			cwd_relative: ".",
			backend: "pty",
			backend_ref: "session",
		});
		processes.markRunning("cancelled", null, null);
		const input = {
			process_id: "cancelled",
			idempotency_key: uuidv7(),
			grace_ms: 0,
		};
		await expect(supervisor.cancel(input)).rejects.toThrow(
			"output unavailable after termination",
		);
		expect(processes.get("cancelled")?.state).toBe("cancelled");
		expect(operations.getState(input.idempotency_key)).toBe("succeeded");
		await expect(supervisor.cancel(input)).resolves.toMatchObject({
			state: "cancelled",
			process_id: "cancelled",
		});
		expect(terminal.close).toHaveBeenCalledTimes(1);
	});

	it("does not resend cancellation with an unconfirmed outcome", async () => {
		const terminal = {
			close: vi.fn(async () => {
				throw new Error("termination ACK lost");
			}),
		} as unknown as InteractiveSessionManager;
		const { supervisor, processes, operations } =
			processFixtures.createProcessSupervisorFixture({ terminal });
		processes.create({
			process_id: "uncertain",
			idempotency_key: uuidv7(),
			target_id: "test",
			argv_digest: "sha256:test",
			cwd_relative: ".",
			backend: "pty",
			backend_ref: "session",
		});
		processes.markRunning("uncertain", null, null);
		const input = {
			process_id: "uncertain",
			idempotency_key: uuidv7(),
			grace_ms: 0,
		};
		await expect(supervisor.cancel(input)).rejects.toThrow(
			"termination ACK lost",
		);
		expect(operations.getState(input.idempotency_key)).toBe("unknown");
		await expect(supervisor.cancel(input)).resolves.toMatchObject({
			state: "unknown",
		});
		expect(terminal.close).toHaveBeenCalledTimes(1);
	});

	it("rejects new process output when the retained spool budget is already exhausted", async () => {
		const { supervisor, config } =
			processFixtures.createProcessSupervisorFixture({
				maxTotalSpoolBytes: 10,
			});
		const retained = join(
			config.server.data_dir,
			"spools",
			"processes",
			"proc_retained",
		);
		mkdirSync(retained, { recursive: true });
		writeFileSync(join(retained, "stdout.bin"), "1234567890");
		await expect(
			supervisor.start(processStartInput(), "req_spool_full"),
		).rejects.toMatchObject({
			code: "SERVER_BUSY",
			retryable: true,
			details: {
				resource: "process_output_spool",
				reason: "capacity_saturated",
				max_total_spool_bytes: 10,
			},
		});
	});

	it("replays a pre-spawn capacity rejection for the same idempotency key", async () => {
		const { supervisor, config } =
			processFixtures.createProcessSupervisorFixture({
				maxTotalSpoolBytes: 10,
			});
		const retained = join(
			config.server.data_dir,
			"spools",
			"processes",
			"proc_retained_retry",
		);
		mkdirSync(retained, { recursive: true });
		writeFileSync(join(retained, "stdout.bin"), "1234567890");
		const input = processStartInput({
			idempotency_key: uuidv7(),
			max_output_bytes: 8,
		});

		for (let attempt = 0; attempt < 2; attempt += 1) {
			await expect(
				supervisor.start(input, `req_spool_retry_${attempt}`),
			).rejects.toMatchObject({
				code: "SERVER_BUSY",
				message:
					"Process output retention budget cannot satisfy the requested output cap; retry after retained output expires.",
				retryable: true,
				details: {
					resource: "process_output_spool",
					reason: "capacity_saturated",
					requested_output_bytes: 8,
					remaining_output_bytes: 0,
				},
			});
		}
	});

	it("reserves the shared spool budget across concurrent process starts", async () => {
		const { supervisor, config } =
			processFixtures.createProcessSupervisorFixture({
				maxTotalSpoolBytes: 10,
			});
		const delayedOutput =
			"setTimeout(()=>process.stdout.write('12345678'),300);setTimeout(()=>{},60000)";
		const first = await supervisor.start(
			processStartInput({
				argv: ["node", "-e", delayedOutput],
				wait_ms: 0,
				deadline_ms: 60_000,
				max_output_bytes: 8,
			}),
			"req_spool_reserve_1",
		);
		await expect(
			supervisor.start(
				processStartInput({
					argv: ["node", "-e", delayedOutput],
					wait_ms: 0,
					deadline_ms: 60_000,
					max_output_bytes: 8,
				}),
				"req_spool_reserve_2",
			),
		).rejects.toMatchObject({
			code: "SERVER_BUSY",
			retryable: true,
			details: {
				resource: "process_output_spool",
				reason: "capacity_saturated",
				requested_output_bytes: 8,
				remaining_output_bytes: 2,
				max_total_spool_bytes: 10,
			},
		});
		const root = join(config.server.data_dir, "spools", "processes");
		let total = 0;
		for (const processId of [String(first.process_id)]) {
			const path = join(root, processId, "stdout.bin");
			if (existsSync(path))
				total += Buffer.byteLength(
					String((await import("node:fs")).readFileSync(path)),
				);
		}
		expect(total).toBeLessThanOrEqual(10);
		await supervisor.cancel({
			idempotency_key: uuidv7(),
			process_id: String(first.process_id),
			grace_ms: 50,
		});
	});

	it("does not return from cancel while native stdio callbacks can still touch durable state", async () => {
		const { supervisor, db } = processFixtures.createProcessSupervisorFixture();
		const started = await supervisor.start(
			processStartInput({
				argv: ["node", "-e", "setInterval(()=>process.stdout.write('x'),5)"],
				wait_ms: 0,
				deadline_ms: 60_000,
				max_output_bytes: 64 * 1024,
			}),
			"req_cancel_stdio_settle",
		);
		const cancelled = await supervisor.cancel({
			idempotency_key: uuidv7(),
			process_id: String(started.process_id),
			grace_ms: 50,
		});
		expect(cancelled.state).toBe("cancelled");

		processFixtures.releaseSupervisor(supervisor);
		processFixtures.releaseDatabase(db);
		db.close();

		// If cancel returns before stdout/stderr have settled, a late data event
		// will attempt to read the now-closed database and Vitest will report an
		// unhandled exception during this window.
		await new Promise((resolve) => setTimeout(resolve, 250));
	});

	it("kills a process group including descendants on cancel", async () => {
		const { supervisor, processes } =
			processFixtures.createProcessSupervisorFixture();
		const script =
			"const {spawn}=require('node:child_process');spawn('node',['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});setTimeout(()=>{},60000)";
		const started = await supervisor.start(
			processStartInput({
				argv: ["node", "-e", script],
				wait_ms: 30,
				deadline_ms: 60_000,
			}),
			"req_tree",
		);
		const record = processes.get(String(started.process_id));
		expect(record?.pgid).toBeTruthy();
		const cancelled = await supervisor.cancel({
			idempotency_key: uuidv7(),
			process_id: String(started.process_id),
			grace_ms: 50,
		});
		expect(cancelled.state).toBe("cancelled");
		expect(processGroupAlive(record?.pgid ?? null)).toBe(false);
	});

	it("enforces explicit deadlines but only caps capture for verbose work", async () => {
		const { supervisor, targetRoot } =
			processFixtures.createProcessSupervisorFixture();
		const timed = await supervisor.start(
			processStartInput({
				argv: ["node", "-e", "setTimeout(()=>{},60000)"],
				wait_ms: 400,
				deadline_ms: 80,
			}),
			"req_timeout",
		);
		expect(timed.state).toBe("timed_out");

		const capped = await supervisor.start(
			processStartInput({
				argv: [
					"node",
					"-e",
					"process.stdout.write('0123456789abcdef'.repeat(625),()=>setTimeout(()=>require('node:fs').writeFileSync('done','ok'),100))",
				],
				deadline_ms: undefined,
				wait_ms: 1_000,
				max_output_bytes: 128,
				max_bytes: 16,
			}),
			"req_cap",
		);
		expect(capped.state).toBe("succeeded");
		expect(capped.deadline_at).toBeNull();
		expect(readFileSync(join(targetRoot, "done"), "utf8")).toBe("ok");
		expect(capped.output_budget).toEqual({
			scope: "retained_output",
			limit_bytes: 128,
			used_bytes: 128,
			remaining_bytes: 0,
		});
		expect(capped.stdout).toBe("01234567");
		expect(capped.stdout_dropped_bytes).toBe(9_872);
		expect(capped.stdout_earliest_cursor).toBe(9_872);
	});
});
