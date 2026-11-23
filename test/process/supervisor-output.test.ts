import fs, { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
	HostSpanConfigSchema,
	type HostSpanConfig,
} from "../../src/config/schema.js";
import { createInitialConfig } from "../../src/config/defaults.js";
import {
	OutputSpool,
	cleanupExpiredProcessSpools,
} from "../../src/processes/output-spool.js";
import {
	ProcessSupervisorTestContext,
	processStartInput,
	pollProcessUntilTerminal,
	waitForNativeProcessOutput,
} from "../helpers/process-supervisor-fixture.js";

const processFixtures = new ProcessSupervisorTestContext();

afterEach(async () => {
	await processFixtures.dispose();
});

describe("process supervisor output and retention", () => {
	it("defaults new and omitted process output retention to 24 hours while honoring an explicit 60 minutes", () => {
		const initial = createInitialConfig();
		expect(initial.retention).toMatchObject({
			completed_process_output_ttl_minutes: 1_440,
			operation_result_days: 14,
			audit_days: 30,
			max_total_spool_bytes: 1_073_741_824,
		});
		const omittedRetention: Partial<HostSpanConfig["retention"]> = {
			...initial.retention,
		};
		delete omittedRetention.completed_process_output_ttl_minutes;
		const omitted = HostSpanConfigSchema.parse({
			...initial,
			retention: omittedRetention,
		});
		expect(omitted.retention.completed_process_output_ttl_minutes).toBe(1_440);
		const explicit = HostSpanConfigSchema.parse({
			...initial,
			retention: {
				...omittedRetention,
				completed_process_output_ttl_minutes: 60,
			},
		});
		expect(explicit.retention.completed_process_output_ttl_minutes).toBe(60);
	});

	it("retains completed output up to 24 hours and reports expiry without losing process metadata", async () => {
		const { supervisor, processes } =
			processFixtures.createProcessSupervisorFixture({
				completedOutputTtlMinutes: 1_440,
			});
		const earliestFinishMs = Date.now();
		const started = await supervisor.start(
			processStartInput({ wait_ms: 0 }),
			"req_output_ttl_24h",
		);
		const id = String(started.process_id);
		const completed = await pollProcessUntilTerminal(supervisor, id);
		expect(completed).toMatchObject({
			state: "succeeded",
			stdout: "ok",
			output_expired: false,
		});

		const expiry = Date.parse(String(processes.get(id)?.output_expires_at));
		const expectedTtlMs = 1_440 * 60_000;
		expect(expiry).toBeGreaterThanOrEqual(earliestFinishMs + expectedTtlMs);
		expect(expiry).toBeLessThanOrEqual(Date.now() + expectedTtlMs);

		const input = {
			process_id: id,
			stdout_cursor: 0,
			stderr_cursor: 0,
			max_bytes: 1024,
			wait_ms: 0,
		};
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date(expiry - 1));
			expect(await supervisor.poll(input)).toMatchObject({
				state: "succeeded",
				stdout: "ok",
				output_expired: false,
			});
			vi.setSystemTime(new Date(expiry));
			expect(await supervisor.poll(input)).toMatchObject({
				state: "succeeded",
				exit_code: 0,
				stdout: "",
				output_expired: true,
				stdout_dropped_bytes: 2,
				stdout_earliest_cursor: 2,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["stdout", "stderr"] as const)(
		"returns unread native %s immediately",
		async (stream) => {
			const { supervisor, processes } =
				processFixtures.createProcessSupervisorFixture();
			const started = await supervisor.start(
				processStartInput({
					argv: [
						"node",
						"-e",
						`setTimeout(()=>process.${stream}.write('ready'),1100);setInterval(()=>{},1000)`,
					],
					wait_ms: 0,
				}),
				"req_ready_output",
			);
			const processId = String(started.process_id);
			await waitForNativeProcessOutput(
				supervisor,
				processes,
				processId,
				stream,
			);
			expect(processes.get(processId)?.[`${stream}_bytes`]).toBe(5);
			const before = Date.now();
			const result = await supervisor.poll({
				process_id: processId,
				stdout_cursor: 0,
				stderr_cursor: 0,
				max_bytes: 1024,
				wait_ms: 2_000,
			});
			expect(result[stream]).toBe("ready");
			expect(Date.now() - before).toBeLessThan(1_000);
		},
	);

	it("waits when native output contains only an incomplete UTF-8 character", async () => {
		const { supervisor, processes } =
			processFixtures.createProcessSupervisorFixture();
		const started = await supervisor.start(
			processStartInput({
				argv: [
					"node",
					"-e",
					"process.stdout.write(Buffer.from([0xe2]));setInterval(()=>{},1000)",
				],
				wait_ms: 0,
			}),
			"req_partial_output",
		);
		const processId = String(started.process_id);
		await waitForNativeProcessOutput(
			supervisor,
			processes,
			processId,
			"stdout",
		);
		expect(processes.get(processId)?.stdout_bytes).toBe(1);
		const before = Date.now();
		const result = await supervisor.poll({
			process_id: processId,
			stdout_cursor: 0,
			stderr_cursor: 0,
			max_bytes: 1024,
			wait_ms: 150,
		});
		expect(result.next_stdout_cursor).toBe(0);
		expect(Date.now() - before).toBeGreaterThanOrEqual(125);
	});

	it("returns a terminal result for a short process", async () => {
		const { supervisor } = processFixtures.createProcessSupervisorFixture();
		const started = await supervisor.start(processStartInput(), "req_short");
		const result =
			started.state === "running"
				? await pollProcessUntilTerminal(supervisor, String(started.process_id))
				: started;
		expect(result.state).toBe("succeeded");
		expect(result.stdout).toBe("ok");
		expect(result.output_budget).toEqual({
			scope: "retained_output",
			limit_bytes: 1024 * 1024,
			used_bytes: 2,
			remaining_bytes: 1024 * 1024 - 2,
		});
		expect(result.deadline_at).toEqual(expect.any(String));
		expect(result.native_execution).toBe(true);
		expect(result.sandboxed).toBe(false);
	});

	it("releases completed runtime handles instead of retaining every finished process", async () => {
		const { supervisor } = processFixtures.createProcessSupervisorFixture();
		for (let index = 0; index < 12; index += 1) {
			const started = await supervisor.start(
				processStartInput({ argv: ["node", "-e", "process.exit(0)"] }),
				`req_cleanup_${index}`,
			);
			const result =
				started.state === "running"
					? await pollProcessUntilTerminal(
							supervisor,
							String(started.process_id),
						)
					: started;
			expect(result.state).toBe("succeeded");
		}
		const runtimes = (
			supervisor as unknown as { runtimes: Map<string, unknown> }
		).runtimes;
		expect(runtimes.size).toBe(0);
	});

	it("preserves output and cursors when an append publishes during a read", () => {
		const root = mkdtempSync(join(tmpdir(), "hostspan-spool-read-"));
		processFixtures.trackRoot(root);
		const writer = new OutputSpool(root, "concurrent-read", 128);
		writer.append("stdout", Buffer.alloc(4096, 120));
		writer.append("stdout", Buffer.from("INFO:RECOVERY_READY\r\n"));
		const cursor = writer.highWater("stdout");
		writer.append("stdout", Buffer.from("resume"));
		const reader = new OutputSpool(root, "concurrent-read", 128);
		const echo = reader.read("stdout", cursor, 32);
		const original = fs.readFileSync;
		let appended = false;
		fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
			const result = Reflect.apply(original, fs, args);
			if (!appended && String(args[0]).endsWith("index.json")) {
				appended = true;
				writer.append("stdout", Buffer.from("RECOVERED\r\n"));
			}
			return result;
		}) as typeof fs.readFileSync;
		syncBuiltinESMExports();
		let during: ReturnType<OutputSpool["read"]>;
		try {
			during = reader.read("stdout", echo.next_cursor, 32);
		} finally {
			fs.readFileSync = original;
			syncBuiltinESMExports();
		}
		const after = reader.read("stdout", during.next_cursor, 32);
		expect(echo.text + during.text + after.text).toBe("resumeRECOVERED\r\n");
		expect(during.dropped_bytes + after.dropped_bytes).toBe(0);
	});

	it("evicts oldest completed spool artifacts when retained output exceeds the budget", () => {
		const root = mkdtempSync(join(tmpdir(), "hostspan-spool-budget-"));
		processFixtures.trackRoot(root);
		for (const processId of ["proc_old", "proc_new"]) {
			const spoolDir = join(root, "spools", "processes", processId);
			mkdirSync(spoolDir, { recursive: true });
			writeFileSync(join(spoolDir, "stdout.bin"), "1234567890");
			mkdirSync(join(root, "sessions", processId), { recursive: true });
		}
		const result = cleanupExpiredProcessSpools(root, [], 12, [
			"proc_old",
			"proc_new",
		]);
		expect(result).toMatchObject({
			evicted: ["proc_old"],
			total_bytes: 10,
			over_quota: false,
		});
		expect(existsSync(join(root, "spools", "processes", "proc_old"))).toBe(
			false,
		);
		expect(existsSync(join(root, "sessions", "proc_old"))).toBe(false);
		expect(existsSync(join(root, "spools", "processes", "proc_new"))).toBe(
			true,
		);
	});

	it("returns a process_id quickly for a long silent process and deduplicates retries", async () => {
		const { supervisor } = processFixtures.createProcessSupervisorFixture();
		const input = processStartInput({
			argv: ["node", "-e", "setTimeout(()=>{}, 60000)"],
			wait_ms: 20,
			deadline_ms: 60_000,
		});
		const startedAt = Date.now();
		const first = await supervisor.start(input, "req_long_1");
		expect(Date.now() - startedAt).toBeLessThan(2_000);
		expect(first.state).toBe("running");
		const second = await supervisor.start(input, "req_long_2");
		expect(second.process_id).toBe(first.process_id);
		expect(
			(
				await supervisor.cancel({
					idempotency_key: uuidv7(),
					process_id: String(first.process_id),
					grace_ms: 100,
				})
			).state,
		).toBe("cancelled");
	});

	it("preserves UTF-8 characters across process output chunk boundaries", async () => {
		const { supervisor } = processFixtures.createProcessSupervisorFixture();
		const script =
			"const b=Buffer.from('😀');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),80)";
		const started = await supervisor.start(
			processStartInput({ argv: ["node", "-e", script], wait_ms: 0 }),
			"req_utf8",
		);
		const first = await supervisor.poll({
			process_id: String(started.process_id),
			stdout_cursor: 0,
			stderr_cursor: 0,
			wait_ms: 20,
			max_bytes: 1024,
		});
		expect(first.stdout === "" || first.stdout === "😀").toBe(true);
		let current = first;
		let text = String(first.stdout ?? "");
		for (let attempt = 0; attempt < 8 && !text.includes("😀"); attempt += 1) {
			current = await supervisor.poll({
				process_id: String(started.process_id),
				stdout_cursor: Number(current.next_stdout_cursor ?? 0),
				stderr_cursor: 0,
				wait_ms: 500,
				max_bytes: 1024,
			});
			text += String(current.stdout ?? "");
		}
		expect(text).toBe("😀");
	});

	it("advances a byte cursor even when max_bytes is smaller than one UTF-8 code point", async () => {
		const { supervisor } = processFixtures.createProcessSupervisorFixture();
		const started = await supervisor.start(
			processStartInput({
				argv: ["node", "-e", "process.stdout.write('😀')"],
				wait_ms: 0,
			}),
			"req_utf8_tiny_cursor",
		);
		let cursor = 0;
		let text = "";
		for (let attempt = 0; attempt < 8 && text !== "😀"; attempt += 1) {
			const result = await supervisor.poll({
				process_id: String(started.process_id),
				stdout_cursor: cursor,
				stderr_cursor: 0,
				wait_ms: 500,
				max_bytes: 1,
			});
			const nextCursor = Number(result.next_stdout_cursor ?? cursor);
			expect(nextCursor).toBeGreaterThanOrEqual(cursor);
			if (result.stdout === "") expect(nextCursor).toBe(cursor);
			text += String(result.stdout ?? "");
			cursor = nextCursor;
		}
		expect(text).toBe("😀");
		expect(cursor).toBe(4);
	});
});
