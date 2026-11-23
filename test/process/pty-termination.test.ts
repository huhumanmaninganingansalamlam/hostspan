import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { recoverProcesses } from "../../src/processes/recovery.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";
import {
	PtyTerminalTestContext,
	sleep,
	pidAlive,
	ttyInput,
} from "../helpers/pty-terminal-fixture.js";

const ptyFixtures = new PtyTerminalTestContext();

afterEach(async () => {
	vi.unstubAllEnvs();
	await ptyFixtures.dispose();
});

describe("PTY termination and authorization", () => {
	it("kills PTY descendants when process_cancel terminates an interactive session", async () => {
		const { supervisor, terminal, db } = ptyFixtures.createPtyTerminalFixture();
		const script = [
			"const {spawn}=require('node:child_process');",
			"const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore',windowsHide:true});",
			"console.log('CHILD='+child.pid);",
			"setTimeout(()=>{},60000);",
		].join("");
		const started = await supervisor.start(
			ttyInput(script, 20_000, 1_000),
			"req_pty_tree_cancel",
		);
		ptyFixtures.trackSession(terminal, started);
		let current = started;
		let transcript = String(started.stdout ?? "");
		for (
			let attempt = 0;
			attempt < 16 && !transcript.includes("CHILD=");
			attempt += 1
		) {
			current = await supervisor.poll({
				process_id: String(started.process_id),
				stdout_cursor: Number(current.next_stdout_cursor ?? 0),
				stderr_cursor: 0,
				wait_ms: 500,
				max_bytes: 64 * 1024,
			});
			transcript += String(current.stdout ?? "");
		}
		const match = /CHILD=(\d+)/.exec(transcript);
		if (!match?.[1])
			throw new Error(
				`PTY descendant fixture did not report its child PID: ${transcript}`,
			);
		const childPid = Number(match[1]);
		expect(pidAlive(childPid)).toBe(true);

		const cancelled = await supervisor.cancel({
			idempotency_key: uuidv7(),
			process_id: String(started.process_id),
			grace_ms: 200,
		});
		expect(cancelled.state).toBe("cancelled");
		for (let attempt = 0; attempt < 40 && pidAlive(childPid); attempt += 1)
			await sleep(50);
		expect(pidAlive(childPid)).toBe(false);
		db.close();
	}, 15_000);

	it.runIf(process.platform === "win32")(
		"kills PTY descendants when synchronous recovery cleanup closes ConPTY",
		async () => {
			const { supervisor, terminal, db } =
				ptyFixtures.createPtyTerminalFixture();
			const script = [
				"const {spawn}=require('node:child_process');",
				"const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore',windowsHide:true});",
				"console.log('CHILD='+child.pid);",
				"setTimeout(()=>{},60000);",
			].join("");
			const started = await supervisor.start(
				ttyInput(script, 20_000, 1_000),
				"req_pty_tree_cleanup",
			);
			const session = ptyFixtures.trackSession(terminal, started);
			let current = started;
			let transcript = String(started.stdout ?? "");
			for (
				let attempt = 0;
				attempt < 12 && !transcript.includes("CHILD=");
				attempt += 1
			) {
				current = await supervisor.poll({
					process_id: String(started.process_id),
					stdout_cursor: Number(current.next_stdout_cursor ?? 0),
					stderr_cursor: 0,
					wait_ms: 500,
					max_bytes: 64 * 1024,
				});
				transcript += String(current.stdout ?? "");
			}
			const match = /CHILD=(\d+)/.exec(transcript);
			if (!match?.[1])
				throw new Error(
					`PTY descendant fixture did not report its child PID: ${transcript}`,
				);
			const childPid = Number(match[1]);
			expect(pidAlive(childPid)).toBe(true);

			terminal.closeSync(session);
			await sleep(250);
			expect(pidAlive(childPid)).toBe(false);
			db.close();
		},
	);

	it.runIf(process.platform === "win32")(
		"preserves literal cmd/bat argv through the ConPTY worker",
		async () => {
			const { root, supervisor, terminal, db } =
				ptyFixtures.createPtyTerminalFixture();
			const targetRoot = join(root, "target");
			const output = join(targetRoot, "captured-argv.json");
			const helper = join(targetRoot, "capture.js");
			const commandFile = join(targetRoot, "capture args.cmd");
			const expected = [
				"",
				"space value",
				"amp&value",
				"pipe|value",
				"caret^value",
				"bang!value",
				"percent%HOSTSPAN_META%value",
				'quote"value',
				"paren(value)",
			];
			writeFileSync(
				helper,
				"require('node:fs').writeFileSync(process.env.HOSTSPAN_ARGV_OUT,JSON.stringify(process.argv.slice(2)));process.stdout.write('CAPTURED')",
			);
			writeFileSync(commandFile, `@"${process.execPath}" "${helper}" %*\r\n`);
			const started = await supervisor.start(
				{
					...ttyInput("", 10_000, 1_000),
					argv: [commandFile, ...expected],
					env: { HOSTSPAN_META: "EXPANDED", HOSTSPAN_ARGV_OUT: output },
				},
				"req_pty_cmd_argv",
			);
			ptyFixtures.trackSession(terminal, started);
			let current = started;
			for (
				let attempt = 0;
				attempt < 16 && current.state === "running";
				attempt += 1
			) {
				current = await supervisor.poll({
					process_id: String(started.process_id),
					stdout_cursor: Number(current.next_stdout_cursor ?? 0),
					stderr_cursor: 0,
					wait_ms: 500,
					max_bytes: 64 * 1024,
				});
			}
			expect(current.state).toBe("succeeded");
			expect(existsSync(output)).toBe(true);
			expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(expected);
			db.close();
		},
	);

	it("preserves final PTY output before recording terminal completion", async () => {
		const { supervisor, terminal, db } = ptyFixtures.createPtyTerminalFixture();
		const payload = `TAIL-${"x".repeat(16_384)}-END`;
		const started = await supervisor.start(
			ttyInput(`process.stdout.write(${JSON.stringify(payload)})`),
			"req_pty_drain",
		);
		ptyFixtures.trackSession(terminal, started);
		let current = started;
		let transcript = String(started.stdout ?? "");
		// Output wakes poll before wait_ms elapses; eight calls are not a four-second completion wait.
		await expect
			.poll(
				async () => {
					current = await supervisor.poll({
						process_id: String(started.process_id),
						stdout_cursor: Number(current.next_stdout_cursor ?? 0),
						stderr_cursor: 0,
						wait_ms: 500,
						max_bytes: 64 * 1024,
					});
					transcript += String(current.stdout ?? "");
					return current.state;
				},
				{ timeout: 4_000 },
			)
			.toBe("succeeded");
		expect(transcript).toContain("TAIL-");
		expect(transcript).toContain("-END");
		expect(
			terminal.outputBytes(String(started.process_id)),
		).toBeGreaterThanOrEqual(Buffer.byteLength(payload));
		db.close();
	});

	it("enforces interactive deadlines in the session worker while the daemon is absent", async () => {
		const first = ptyFixtures.createPtyTerminalFixture();
		const deadlineMs = process.platform === "win32" ? 3_000 : 400;
		const input = ttyInput("setTimeout(()=>{},60000)", deadlineMs, 0);
		const processId = `proc_${uuidv7().replaceAll("-", "")}`;
		const session = first.terminal.sessionName(processId);
		const deadlineAt = new Date(Date.now() + deadlineMs).toISOString();
		first.operations.resolve(
			input.idempotency_key,
			"process_start",
			input,
			input.target_id,
		);
		first.processes.create({
			process_id: processId,
			idempotency_key: input.idempotency_key,
			target_id: input.target_id,
			argv_digest: "deadline-worker-fixture",
			cwd_relative: input.cwd,
			backend: "pty",
			backend_ref: session,
			deadline_at: deadlineAt,
		});
		// Close the daemon database before launching the independent worker.
		// Its startup need not fit inside the process deadline to prove enforcement.
		first.db.close();
		ptyFixtures.trackSessionName(first.terminal, session);
		await first.terminal.start({
			processId,
			cwd: join(first.root, "target"),
			argv: input.argv,
			env: input.env,
			columns: input.columns,
			rows: input.rows,
			deadlineAt,
			maxOutputBytes: input.max_output_bytes,
		});
		await sleep(deadlineMs + (process.platform === "win32" ? 1_000 : 300));

		const db = openDatabase(join(first.config.server.data_dir, "state.db"));
		const operations = new OperationsRepo(db);
		const processes = new ProcessesRepo(db);
		const recovered = recoverProcesses(processes, operations, first.terminal);
		expect(recovered).toContainEqual({
			process_id: processId,
			state: "timed_out",
		});
		expect(processes.get(processId)).toMatchObject({
			state: "timed_out",
			reason: "deadline_exceeded",
		});
		db.close();
	});

	it("classifies a vanished session worker as unknown instead of success", async () => {
		const first = ptyFixtures.createPtyTerminalFixture();
		const started = await first.supervisor.start(
			ttyInput("setTimeout(()=>{},60000)"),
			"req_pty_worker_crash",
		);
		const session = ptyFixtures.trackSession(first.terminal, started);
		const processId = String(started.process_id);
		const statusPath = join(
			first.config.server.data_dir,
			"sessions",
			session,
			"status.json",
		);
		const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
			worker_pid: number;
		};
		process.kill(status.worker_pid, "SIGKILL");
		await sleep(150);
		first.db.close();

		const db = openDatabase(join(first.config.server.data_dir, "state.db"));
		const operations = new OperationsRepo(db);
		const processes = new ProcessesRepo(db);
		expect(
			recoverProcesses(processes, operations, first.terminal),
		).toContainEqual({ process_id: processId, state: "unknown" });
		expect(processes.get(processId)).toMatchObject({
			state: "unknown",
			reason: "pty_session_missing_after_restart",
		});
		db.close();
	});

	it("requires an explicit terminal capability even when exec is allowed", async () => {
		const { supervisor, db } = ptyFixtures.createPtyTerminalFixture({
			terminalCapability: false,
		});
		await expect(
			supervisor.start(ttyInput("setTimeout(()=>{},1000)"), "req_pty_denied"),
		).rejects.toMatchObject({ code: "SCOPE_DENIED" });
		db.close();
	});
});
