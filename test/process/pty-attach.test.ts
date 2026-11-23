import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { ProcessWriteToolInput } from "../../src/tools/schemas.js";
import { PtySessionManager } from "../../src/processes/pty-session.js";
import { claimRuntimeGeneration } from "../../src/state/database.js";
import {
	PtyTerminalTestContext,
	sleep,
	ttyInput,
} from "../helpers/pty-terminal-fixture.js";

const ptyFixtures = new PtyTerminalTestContext();

afterEach(async () => {
	vi.unstubAllEnvs();
	await ptyFixtures.dispose();
});

describe("PTY input and attachments", () => {
	it("supports interactive input, polling, resize, attach metadata, and idempotent writes", async () => {
		const { configPath, supervisor, terminal, db } =
			ptyFixtures.createPtyTerminalFixture();
		const script = [
			"const readline=require('node:readline');",
			"const rl=readline.createInterface({input:process.stdin,output:process.stdout});",
			"console.log('READY');",
			"rl.question('NAME? ',name=>{console.log('HELLO '+name);rl.close();process.exit(0);});",
		].join("");
		const started = await supervisor.start(ttyInput(script), "req_pty_start");
		ptyFixtures.trackSession(terminal, started);
		expect(started.interactive).toBe(true);
		expect(started.backend).toBe("pty");
		expect(String(started.human_attach_command)).toContain(
			`hostspan terminal attach --process '${started.process_id}'`,
		);
		expect(String(started.human_attach_command)).toContain(
			`--config '${configPath}'`,
		);
		expect(String(started.human_attach_read_only_command)).toContain(
			`--config '${configPath}'`,
		);
		expect(String(started.human_attach_read_only_command)).toContain(
			"--read-only",
		);
		let ready = started;
		await expect
			.poll(
				async () => {
					if (!String(ready.stdout).includes("READY")) {
						ready = await supervisor.poll({
							process_id: String(started.process_id),
							stdout_cursor: 0,
							stderr_cursor: 0,
							wait_ms: 100,
							max_bytes: 64 * 1024,
						});
					}
					return String(ready.stdout).includes("READY");
				},
				{ timeout: 5_000 },
			)
			.toBe(true);
		const startedBudget = ready.output_budget as Record<string, unknown>;
		expect(startedBudget.scope).toBe("retained_output");
		expect(startedBudget.limit_bytes).toBe(1024 * 1024);
		expect(Number(startedBudget.used_bytes)).toBeGreaterThan(0);
		expect(startedBudget.remaining_bytes).toBe(
			1024 * 1024 - Number(startedBudget.used_bytes),
		);

		const cursor = Number(ready.next_stdout_cursor ?? 0);
		const writeInput: ProcessWriteToolInput = {
			idempotency_key: uuidv7(),
			process_id: String(started.process_id),
			chars: "world",
			control_keys: ["Enter"],
			columns: 132,
			rows: 42,
			stdout_cursor: cursor,
			wait_ms: 1_000,
			max_bytes: 64 * 1024,
		};
		const [written, joined] = await Promise.all([
			supervisor.write(writeInput),
			supervisor.write(writeInput),
		]);
		expect(joined).toEqual(written);
		await expect(supervisor.write(writeInput)).resolves.toEqual(written);
		await expect(
			supervisor.write({ ...writeInput, chars: "duplicate" }),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

		let current = written;
		let transcript = String(written.stdout ?? "");
		const completionAttempts = process.platform === "win32" ? 24 : 8;
		for (
			let attempt = 0;
			attempt < completionAttempts &&
			(current.state === "running" || !transcript.includes("HELLO world"));
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
		expect(transcript).toContain("HELLO world");
		expect(current.state).toBe("succeeded");
		const completedBudget = current.output_budget as Record<string, unknown>;
		expect(completedBudget.scope).toBe("retained_output");
		expect(completedBudget.limit_bytes).toBe(1024 * 1024);
		expect(Number(completedBudget.used_bytes)).toBeGreaterThanOrEqual(
			Number(startedBudget.used_bytes),
		);
		expect(completedBudget.remaining_bytes).toBe(
			1024 * 1024 - Number(completedBudget.used_bytes),
		);
		db.close();
	});

	it("preserves raw-attach UTF-8 across chunks and EOF alongside JSON writes", async () => {
		const { root, config, terminal, supervisor, db } =
			ptyFixtures.createPtyTerminalFixture({ requireOwnership: true });
		const generation = claimRuntimeGeneration(db);
		terminal.activateOwnership(generation);
		const capture = join(root, "target", "input-bytes");
		const script = [
			"const fs=require('node:fs');",
			"process.stdin.setRawMode(true);",
			"process.stdin.on('data',data=>fs.appendFileSync('input-bytes',data));",
			"fs.writeFileSync('input-bytes','');",
		].join("");
		const started = await supervisor.start(
			ttyInput(script),
			"req_pty_utf8_attach_start",
		);
		const session = ptyFixtures.trackSession(terminal, started);
		await expect.poll(() => existsSync(capture), { timeout: 5_000 }).toBe(true);
		const input = Buffer.from("START|한글🙂|END");
		const split = Buffer.byteLength("START|") + 1;
		const raw = await ptyFixtures.openRawAttachment(
			config.server.data_dir,
			session,
			false,
			generation,
			input.subarray(0, split),
		);
		// Seeing the ASCII prefix forces the split character into separate worker reads.
		await expect
			.poll(() => readFileSync(capture).length, { timeout: 5_000 })
			.toBeGreaterThanOrEqual(split - 1);
		const eof = new Promise<void>((resolveEnd) =>
			raw.socket.once("end", () => resolveEnd()),
		);
		// A final incomplete character must flush only when the connection reaches EOF.
		raw.socket.end(Buffer.concat([input.subarray(split), Buffer.from([0xed])]));
		await eof;
		const rawExpected = Buffer.concat([input, Buffer.from("\uFFFD")]);
		await expect
			.poll(() => readFileSync(capture), { timeout: 5_000 })
			.toEqual(rawExpected);

		await terminal.write(session, {
			chars: input.toString("utf8"),
			control_keys: [],
		});
		await expect
			.poll(() => readFileSync(capture), { timeout: 5_000 })
			.toEqual(Buffer.concat([rawExpected, input]));
	});

	it("does not replay acknowledged PTY input when output observation fails", async () => {
		const { root, supervisor, terminal } =
			ptyFixtures.createPtyTerminalFixture();
		const countFile = join(root, "target", "input-count");
		const script = [
			"const fs=require('node:fs');",
			"const readline=require('node:readline');",
			"let count=0;",
			"const rl=readline.createInterface({input:process.stdin});",
			`rl.on('line',()=>{count++;fs.writeFileSync(${JSON.stringify(countFile)},String(count));process.stdout.write('COUNT:'+count+'\\n')});`,
			"setTimeout(()=>{},60000);",
		].join("");
		const started = await supervisor.start(
			ttyInput(script),
			"req_pty_write_observation_start",
		);
		const session = ptyFixtures.trackSession(terminal, started);
		const waitForActivity = terminal.waitForActivity.bind(terminal);
		let failObservation = false;
		vi.spyOn(terminal, "waitForActivity").mockImplementation(
			async (...args) => {
				if (failObservation) {
					failObservation = false;
					throw new Error("PTY output observation failed");
				}
				return waitForActivity(...args);
			},
		);
		const input: ProcessWriteToolInput = {
			idempotency_key: uuidv7(),
			process_id: String(started.process_id),
			chars: "once",
			control_keys: ["Enter"],
			stdout_cursor: Number(started.next_stdout_cursor ?? 0),
			wait_ms: 500,
			max_bytes: 256,
		};
		failObservation = true;
		await expect(supervisor.write(input)).rejects.toMatchObject({
			details: { input_delivered: true, phase: "output_observation" },
		});
		await expect
			.poll(() =>
				existsSync(countFile) ? readFileSync(countFile, "utf8") : undefined,
			)
			.toBe("1");

		const retried = await supervisor.write(input);
		expect(retried.input_delivered).toBe(true);
		await sleep(100);
		expect(readFileSync(countFile, "utf8")).toBe("1");

		let current = retried;
		let transcript = String(retried.stdout ?? "");
		let cursor = Number(retried.next_stdout_cursor ?? input.stdout_cursor);
		for (
			let attempt = 0;
			attempt < 8 && !transcript.includes("COUNT:1");
			attempt += 1
		) {
			current = await supervisor.poll({
				process_id: input.process_id,
				stdout_cursor: cursor,
				stderr_cursor: 0,
				wait_ms: 250,
				max_bytes: input.max_bytes,
			});
			transcript += String(current.stdout ?? "");
			cursor = Number(current.next_stdout_cursor ?? cursor);
		}
		expect(transcript).toContain("COUNT:1");
		expect(terminal.inspectSync(session)).toMatchObject({
			exists: true,
			dead: false,
		});
	});

	it("drops stale writable attachments while preserving read-only observation after takeover", async () => {
		const first = ptyFixtures.createPtyTerminalFixture({
			requireOwnership: true,
		});
		const terminalConfig = first.config.terminal;
		if (!terminalConfig)
			throw new Error("terminal fixture configuration is missing");
		const generation1 = claimRuntimeGeneration(first.db);
		first.terminal.activateOwnership(generation1);
		const script = [
			"process.stdin.setEncoding('utf8');",
			"console.log('READY');",
			"process.stdin.on('data',chunk=>{const value=chunk.trim();console.log('GOT:'+value);if(value==='fresh')setTimeout(()=>process.exit(0),50);});",
		].join("");
		const started = await first.supervisor.start(
			ttyInput(script, 10_000, 300),
			"req_pty_attach_owner_start",
		);
		const session = String(started.terminal_session);
		ptyFixtures.trackSessionName(first.terminal, session);
		const writable = await ptyFixtures.openRawAttachment(
			first.config.server.data_dir,
			session,
			false,
			generation1,
		);
		const readOnly = await ptyFixtures.openRawAttachment(
			first.config.server.data_dir,
			session,
			true,
		);

		const secondTerminal = new PtySessionManager(
			first.config.server.data_dir,
			terminalConfig,
			{ requireOwnership: true },
		);
		const generation2 = claimRuntimeGeneration(first.db);
		expect(generation2).toBe(generation1 + 1);
		secondTerminal.activateOwnership(generation2);
		ptyFixtures.replaceTrackedSessionManager(session, secondTerminal);

		const staleClosed = new Promise<void>((resolveClose) =>
			writable.socket.once("close", () => resolveClose()),
		);
		writable.socket.write("stale\r");
		await Promise.race([staleClosed, sleep(1_000)]);
		expect(writable.socket.destroyed).toBe(true);

		await secondTerminal.write(session, {
			chars: "fresh",
			control_keys: ["Enter"],
		});
		const exited = await secondTerminal.waitForExitStatus(
			session,
			process.platform === "win32" ? 5_000 : 2_000,
		);
		expect(exited).toMatchObject({ exists: true, dead: true });
		for (
			let attempt = 0;
			attempt < 20 && !readOnly.output().includes("GOT:fresh");
			attempt += 1
		)
			await sleep(25);
		expect(readOnly.output()).toContain("GOT:fresh");

		const observed = await first.supervisor.poll({
			process_id: String(started.process_id),
			stdout_cursor: 0,
			stderr_cursor: 0,
			wait_ms: 0,
			max_bytes: 64 * 1024,
		});
		const stdout = String(observed.stdout ?? "");
		expect(stdout).not.toContain("GOT:stale");
		expect(stdout).toContain("GOT:fresh");
		first.db.close();
	});
});
