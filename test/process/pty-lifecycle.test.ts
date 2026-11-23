import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
	PtyTerminalTestContext,
	ttyInput,
} from "../helpers/pty-terminal-fixture.js";

const ptyFixtures = new PtyTerminalTestContext();

afterEach(async () => {
	vi.unstubAllEnvs();
	await ptyFixtures.dispose();
});

describe("PTY process lifecycle", () => {
	it("inherits the same host environment and honors explicit overrides in native and PTY execution", async () => {
		const { root, terminal, supervisor } =
			ptyFixtures.createPtyTerminalFixture();
		vi.stubEnv("HOSTSPAN_INHERITED", "parent");
		vi.stubEnv("HOSTSPAN_OVERRIDDEN", "parent");
		try {
			for (const tty of [false, true]) {
				const output = join(root, tty ? "pty-env.json" : "native-env.json");
				const script = `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify([process.env.HOSTSPAN_INHERITED,process.env.HOSTSPAN_OVERRIDDEN]))`;
				const started = await supervisor.start(
					{
						...ttyInput(script, 10_000, 1_000),
						tty,
						env: { HOSTSPAN_OVERRIDDEN: "caller" },
					},
					"req_environment",
				);
				if (tty)
					ptyFixtures.trackSessionName(
						terminal,
						terminal.sessionName(String(started.process_id)),
					);
				await expect
					.poll(() => existsSync(output), { timeout: 5_000 })
					.toBe(true);
				expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
					"parent",
					"caller",
				]);
			}
		} finally {
			await supervisor.shutdown();
		}
	});

	it("keeps a launching PTY pending while its worker status is still appearing", async () => {
		const { processes, supervisor } = ptyFixtures.createPtyTerminalFixture();
		const processId = "proc_launch_pending";
		processes.create({
			process_id: processId,
			idempotency_key: uuidv7(),
			target_id: "test",
			argv_digest: "sha256:launch-pending",
			cwd_relative: ".",
			backend: "pty",
			backend_ref: processId,
			deadline_at: new Date(Date.now() + 60_000).toISOString(),
			max_output_bytes: 1024 * 1024,
		});

		await supervisor.reconcileInteractiveProcesses("test");

		expect(processes.get(processId)).toMatchObject({
			state: "launching",
			reason: null,
			ended_at: null,
		});
	});

	it("does not revive a terminal process record as running", () => {
		const { processes } = ptyFixtures.createPtyTerminalFixture();
		const processId = "proc_terminal_no_revive";
		processes.create({
			process_id: processId,
			idempotency_key: uuidv7(),
			target_id: "test",
			argv_digest: "sha256:no-revive",
			cwd_relative: ".",
			backend: "pty",
			backend_ref: processId,
		});
		processes.markTerminal(
			processId,
			"unknown",
			null,
			null,
			"launch_race_probe",
		);
		const terminal = processes.get(processId);

		expect(processes.markRunning(processId, 123, null)).toBe(false);
		expect(processes.get(processId)).toMatchObject({
			state: "unknown",
			reason: "launch_race_probe",
			ended_at: terminal?.ended_at,
		});
	});

	it("waits through a transient missing status while an exit is settling", async () => {
		const { terminal, db } = ptyFixtures.createPtyTerminalFixture();
		const snapshots = [
			{
				exists: true,
				dead: false,
				exit_code: null,
				signal: null,
				reason: null,
				pid: 1,
				columns: 80,
				rows: 24,
			},
			{
				exists: false,
				dead: false,
				exit_code: null,
				signal: null,
				reason: null,
				pid: null,
				columns: null,
				rows: null,
			},
			{
				exists: true,
				dead: true,
				exit_code: 1,
				signal: null,
				reason: "cancel_requested",
				pid: 1,
				columns: 80,
				rows: 24,
			},
		];
		let index = 0;
		terminal.inspect = async () => {
			const snapshot = snapshots[Math.min(index++, snapshots.length - 1)];
			if (!snapshot) throw new Error("transient status fixture is empty");
			return snapshot;
		};
		await expect(
			terminal.waitForExitStatus("transient", 250),
		).resolves.toMatchObject({
			exists: true,
			dead: true,
			reason: "cancel_requested",
		});
		db.close();
	});

	it("keeps an accepted PTY cancellable when response observation fails", async () => {
		const { supervisor, terminal, processes } =
			ptyFixtures.createPtyTerminalFixture();
		const input = ttyInput("setTimeout(()=>{},60000)");
		const observationError = new Error("PTY observation unavailable");
		vi.spyOn(terminal, "waitForActivity").mockRejectedValueOnce(
			observationError,
		);
		try {
			await expect(
				supervisor.start(input, "req_observation_failure"),
			).rejects.toBe(observationError);
			const record = processes.getByKey(input.idempotency_key);
			expect(record?.state).toBe("running");
			const retried = await supervisor.start(input, "req_observation_retry");
			expect(retried.process_id).toBe(record?.process_id);
			expect(retried.state).toBe("running");
			const cancelled = await supervisor.cancel({
				idempotency_key: uuidv7(),
				process_id: String(retried.process_id),
				grace_ms: 50,
			});
			expect(cancelled.state).toBe("cancelled");
		} finally {
			const record = processes.getByKey(input.idempotency_key);
			if (record?.backend_ref) terminal.closeSync(record.backend_ref);
		}
	});

	it.each([false, true])(
		"retries an unaccepted start after capacity frees (tty=%s)",
		async (tty) => {
			const { supervisor, config, terminal } =
				ptyFixtures.createPtyTerminalFixture({ maxConcurrentSessions: 1 });
			config.exec_profiles["native-test"] = {
				mode: "native",
				max_concurrent_processes: 1,
			};
			const firstInput = {
				...ttyInput("setTimeout(()=>{},60000)", 60_000, 0),
				tty,
			};
			const waitingInput = { ...firstInput, idempotency_key: uuidv7() };
			try {
				const first = await supervisor.start(firstInput, "capacity-first");
				if (tty) ptyFixtures.trackSession(terminal, first);
				await expect(
					supervisor.start(waitingInput, "capacity-full"),
				).rejects.toMatchObject({ code: "SERVER_BUSY", retryable: true });
				expect(
					(await supervisor.start(firstInput, "capacity-replay")).process_id,
				).toBe(first.process_id);
				expect(
					(
						await supervisor.cancel({
							idempotency_key: uuidv7(),
							process_id: String(first.process_id),
							grace_ms: 50,
						})
					).state,
				).toBe("cancelled");
				const retried = await supervisor.start(waitingInput, "capacity-retry");
				if (tty) ptyFixtures.trackSession(terminal, retried);
				expect(["launching", "running"]).toContain(retried.state);
				expect(retried.process_id).not.toBe(first.process_id);
				expect(
					(
						await supervisor.cancel({
							idempotency_key: uuidv7(),
							process_id: String(retried.process_id),
							grace_ms: 50,
						})
					).state,
				).toBe("cancelled");
			} finally {
				await supervisor.shutdown();
			}
		},
	);

	it("joins concurrent PTY starts with the same idempotency key before launch", async () => {
		const { supervisor, terminal, processes, db } =
			ptyFixtures.createPtyTerminalFixture();
		const input = ttyInput("setTimeout(()=>{},60000)", 10_000, 0);

		const [first, joined] = await Promise.all([
			supervisor.start(input, "req_pty_parallel_start_1"),
			supervisor.start(input, "req_pty_parallel_start_2"),
		]);

		expect(joined.process_id).toBe(first.process_id);
		expect(processes.getByKey(input.idempotency_key)?.process_id).toBe(
			first.process_id,
		);
		expect(
			(
				db
					.prepare(
						"SELECT count(*) AS count FROM processes WHERE idempotency_key=?",
					)
					.get(input.idempotency_key) as {
					count: number;
				}
			).count,
		).toBe(1);
		ptyFixtures.trackSession(terminal, first);
	});

	it("keeps a PTY running after response wait and capture fill without an implicit deadline", async () => {
		const { supervisor, terminal, root } =
			ptyFixtures.createPtyTerminalFixture();
		const started = await supervisor.start(
			{
				...ttyInput(
					"process.stdout.write('0123456789abcdef'.repeat(625)+'\\nCAPTURE_READY\\n');process.stdin.once('data',()=>{require('node:fs').writeFileSync('done','ok');console.log('DONE');process.exit(0)})",
				),
				deadline_ms: undefined,
				max_output_bytes: 128,
				max_bytes: 16,
			},
			"req_pty_capture",
		);
		ptyFixtures.trackSession(terminal, started);
		expect(started.state).toBe("running");
		expect(started.deadline_at).toBeNull();
		let current = started;
		await expect
			.poll(async () => {
				current = await supervisor.poll({
					process_id: String(started.process_id),
					stdout_cursor: 0,
					stderr_cursor: 0,
					wait_ms: 100,
					max_bytes: 128,
				});
				expect(current.state).toBe("running");
				return String(current.stdout);
			})
			.toContain("CAPTURE_READY");
		expect(current.stdout_dropped_bytes).toBeGreaterThan(0);
		expect(current.stdout_earliest_cursor).toBeGreaterThan(0);
		expect(
			Number((current.output_budget as Record<string, unknown>).used_bytes),
		).toBeLessThanOrEqual(128);
		const observer = await ptyFixtures.openRawAttachment(
			join(root, "state"),
			String(started.terminal_session),
			true,
		);
		const cursor = Number(current.next_stdout_cursor ?? 0);
		current = await supervisor.write({
			idempotency_key: uuidv7(),
			process_id: String(started.process_id),
			chars: "go",
			control_keys: ["Enter"],
			stdout_cursor: cursor,
			wait_ms: 1_000,
			max_bytes: 16,
		});
		let transcript = String(current.stdout ?? "");
		let nextCursor = Number(current.next_stdout_cursor ?? cursor);
		for (
			let attempt = 0;
			attempt < 8 &&
			(current.state === "running" || !transcript.includes("DONE"));
			attempt += 1
		) {
			current = await supervisor.poll({
				process_id: String(started.process_id),
				stdout_cursor: nextCursor,
				stderr_cursor: 0,
				wait_ms: 250,
				max_bytes: 16,
			});
			transcript += String(current.stdout ?? "");
			nextCursor = Number(current.next_stdout_cursor ?? nextCursor);
		}
		expect(current.state).toBe("succeeded");
		expect(transcript).toContain("DONE");
		expect(readFileSync(join(root, "target", "done"), "utf8")).toBe("ok");
		// The supervisor spool and this raw socket are independent observers.
		// EOF confirms this client has received all queued data after the child exits.
		if (!observer.socket.readableEnded) await once(observer.socket, "end");
		expect(observer.output()).toContain("DONE");
	});

	it("does not advertise or mark an already-exited PTY launch as running", async () => {
		const { supervisor, terminal, processes, db } =
			ptyFixtures.createPtyTerminalFixture();
		const realStart = terminal.start.bind(terminal);
		terminal.start = async (input) => {
			const started = await realStart(input);
			await terminal.waitForExitStatus(
				started.session,
				process.platform === "win32" ? 5_000 : 2_000,
			);
			return started;
		};

		const started = await supervisor.start(
			ttyInput("process.exit(0)", 10_000, 0),
			"req_pty_fast_exit",
		);
		const record = processes.get(String(started.process_id));
		expect(started.state).toBe("succeeded");
		expect(started).not.toHaveProperty("human_attach_command");
		expect(started).not.toHaveProperty("human_attach_read_only_command");
		expect(record?.started_at).toBeNull();
		expect(record?.ended_at).toEqual(expect.any(String));
		ptyFixtures.trackSessionName(terminal, String(started.process_id));
		db.close();
	});

	it("reclaims a naturally exited PTY slot before admitting the next session", async () => {
		const { root, supervisor, terminal, processes, db } =
			ptyFixtures.createPtyTerminalFixture({ maxConcurrentSessions: 1 });
		const first = await supervisor.start(
			ttyInput(
				"const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync('exit-now')){clearInterval(timer);process.exit(0)}},10)",
				10_000,
				0,
			),
			"req_pty_slot_first",
		);
		const firstSession = ptyFixtures.trackSession(terminal, first);
		expect(first.state).toBe("running");
		writeFileSync(join(root, "target", "exit-now"), "exit\n");
		await expect(
			terminal.waitForExitStatus(
				firstSession,
				process.platform === "win32" ? 5_000 : 2_000,
			),
		).resolves.toMatchObject({
			exists: true,
			dead: true,
		});
		expect(processes.activeInteractive("test")).toHaveLength(1);

		const second = await supervisor.start(
			ttyInput("setTimeout(()=>process.exit(0),50)", 10_000, 0),
			"req_pty_slot_second",
		);
		ptyFixtures.trackSession(terminal, second);
		expect(String(second.process_id)).not.toBe(String(first.process_id));
		expect(processes.get(String(first.process_id))?.state).toBe("succeeded");

		await terminal.waitForExitStatus(
			String(second.terminal_session),
			process.platform === "win32" ? 5_000 : 2_000,
		);
		await supervisor.reconcileInteractiveProcesses("test");
		expect(processes.activeInteractive("test")).toHaveLength(0);
		db.close();
	});
});
