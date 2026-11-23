import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { main } from "../../src/cli/index.js";
import type { ProcessWriteToolInput } from "../../src/tools/schemas.js";
import { PolicyEvaluator } from "../../src/policy/evaluator.js";
import { PtySessionManager } from "../../src/processes/pty-session.js";
import { recoverProcesses } from "../../src/processes/recovery.js";
import { ProcessSupervisor } from "../../src/processes/supervisor.js";
import {
	claimRuntimeGeneration,
	openDatabase,
	runtimeGeneration,
} from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";
import {
	PtyTerminalTestContext,
	ttyInput,
	unusedTcpPort,
} from "../helpers/pty-terminal-fixture.js";

const ptyFixtures = new PtyTerminalTestContext();

afterEach(async () => {
	vi.unstubAllEnvs();
	await ptyFixtures.dispose();
});

describe("PTY runtime recovery", () => {
	it("keeps a live PTY process recoverable across HostSpan daemon restart", async () => {
		const first = ptyFixtures.createPtyTerminalFixture();
		const started = await first.supervisor.start(
			{
				...ttyInput(
					"process.stdout.write('0123456789abcdef'.repeat(256)+'\\nRECOVERY_READY\\n');process.stdin.once('data',()=>process.stdout.write('RECOVERED\\n'))",
				),
				max_output_bytes: 128,
				max_bytes: 128,
			},
			"req_pty_persist_start",
		);
		const session = ptyFixtures.trackSession(first.terminal, started);
		expect(started.state).toBe("running");
		let retained = started;
		await expect
			.poll(async () => {
				retained = await first.supervisor.poll({
					process_id: String(started.process_id),
					stdout_cursor: 0,
					stderr_cursor: 0,
					wait_ms: 100,
					max_bytes: 128,
				});
				return String(retained.stdout);
			})
			.toContain("RECOVERY_READY");
		expect(
			Number((retained.output_budget as Record<string, unknown>).used_bytes),
		).toBeGreaterThan(0);
		expect(
			Number((retained.output_budget as Record<string, unknown>).used_bytes),
		).toBeLessThanOrEqual(128);
		expect(Number(retained.stdout_dropped_bytes)).toBeGreaterThan(0);
		const processId = String(started.process_id);
		first.db.close();

		const db = openDatabase(join(first.config.server.data_dir, "state.db"));
		const operations = new OperationsRepo(db);
		const processes = new ProcessesRepo(db);
		const recovered = recoverProcesses(processes, operations, first.terminal);
		expect(recovered).toContainEqual({
			process_id: processId,
			state: "running",
		});
		expect(first.terminal.inspectSync(session)).toMatchObject({
			exists: true,
			dead: false,
		});

		const supervisor = new ProcessSupervisor({
			config: first.config,
			targets: first.targets,
			policy: new PolicyEvaluator(first.config),
			operations,
			processes,
			terminal: first.terminal,
		});
		const cursor = Number(retained.next_stdout_cursor ?? 0);
		const writeInput: ProcessWriteToolInput = {
			idempotency_key: uuidv7(),
			process_id: processId,
			chars: "resume",
			control_keys: ["Enter"],
			stdout_cursor: cursor,
			wait_ms: 500,
			max_bytes: 32,
		};
		let polled = await supervisor.write(writeInput);
		expect(polled.state).toBe("running");
		let transcript = String(polled.stdout ?? "");
		let nextCursor = Number(polled.next_stdout_cursor ?? cursor);
		for (
			let attempt = 0;
			attempt < 8 && !transcript.includes("RECOVERED");
			attempt += 1
		) {
			polled = await supervisor.poll({
				process_id: processId,
				stdout_cursor: nextCursor,
				stderr_cursor: 0,
				wait_ms: 250,
				max_bytes: 32,
			});
			transcript += String(polled.stdout ?? "");
			nextCursor = Number(polled.next_stdout_cursor ?? nextCursor);
		}
		expect(transcript).toContain("RECOVERED");
		const cancelled = await supervisor.cancel({
			idempotency_key: uuidv7(),
			process_id: processId,
			grace_ms: 200,
		});
		expect(cancelled.state).toBe("cancelled");
		expect(first.terminal.inspectSync(session)).toMatchObject({
			exists: true,
			dead: true,
			reason: "cancel_requested",
		});
		db.close();
	});

	it("does not claim PTY runtime ownership when serve cannot bind", async () => {
		const blocker = createServer();
		await new Promise<void>((resolveListen, rejectListen) => {
			const onError = (error: Error) => rejectListen(error);
			blocker.once("error", onError);
			blocker.listen(0, "127.0.0.1", () => {
				blocker.off("error", onError);
				resolveListen();
			});
		});
		const address = blocker.address();
		if (!address || typeof address === "string")
			throw new Error("test blocker did not return a TCP port");
		const setup = ptyFixtures.createPtyTerminalFixture({
			requireOwnership: true,
			listenPort: address.port,
		});
		expect(runtimeGeneration(setup.db)).toBe(0);
		setup.db.close();

		try {
			await expect(
				main(["serve", "--config", setup.configPath]),
			).rejects.toMatchObject({ code: "EADDRINUSE" });
		} finally {
			await new Promise<void>((resolveClose) =>
				blocker.close(() => resolveClose()),
			);
		}

		const check = openDatabase(join(setup.config.server.data_dir, "state.db"));
		try {
			expect(runtimeGeneration(check)).toBe(0);
		} finally {
			check.close();
		}
	});

	it.runIf(process.platform !== "win32")(
		"does not claim PTY runtime ownership when daemon control setup cannot bind",
		async () => {
			const setup = ptyFixtures.createPtyTerminalFixture({
				requireOwnership: true,
				listenPort: await unusedTcpPort(),
			});
			expect(runtimeGeneration(setup.db)).toBe(0);
			mkdirSync(join(setup.config.server.data_dir, "daemon-control.sock"), {
				recursive: true,
			});
			setup.db.close();

			await expect(
				main(["serve", "--config", setup.configPath]),
			).rejects.toBeInstanceOf(Error);

			const check = openDatabase(
				join(setup.config.server.data_dir, "state.db"),
			);
			try {
				expect(runtimeGeneration(check)).toBe(0);
			} finally {
				check.close();
			}
		},
	);

	it("fences stale PTY owners after runtime generation takeover", async () => {
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
			"process.stdin.on('data',chunk=>{console.log('GOT:'+chunk.trim());process.exit(0);});",
		].join("");
		const started = await first.supervisor.start(
			ttyInput(script, 10_000, 300),
			"req_pty_owner_start",
		);
		const session = String(started.terminal_session);
		ptyFixtures.trackSessionName(first.terminal, session);

		const secondTerminal = new PtySessionManager(
			first.config.server.data_dir,
			terminalConfig,
			{ requireOwnership: true },
		);
		const generation2 = claimRuntimeGeneration(first.db);
		expect(generation2).toBe(generation1 + 1);
		secondTerminal.activateOwnership(generation2);
		ptyFixtures.replaceTrackedSessionManager(session, secondTerminal);

		await expect(
			first.terminal.write(session, {
				chars: "stale",
				control_keys: ["Enter"],
			}),
		).rejects.toMatchObject({
			code: "SERVER_BUSY",
			retryable: true,
			details: { resource: "pty_runtime", reason: "stale_runtime_owner" },
		});
		await expect(first.terminal.close(session, 50)).rejects.toMatchObject({
			code: "SERVER_BUSY",
			details: { resource: "pty_runtime", reason: "stale_runtime_owner" },
		});

		await expect(
			secondTerminal.write(session, {
				chars: "fresh",
				control_keys: ["Enter"],
			}),
		).resolves.toBeUndefined();
		const exited = await secondTerminal.waitForExitStatus(
			session,
			process.platform === "win32" ? 5_000 : 2_000,
		);
		expect(exited).toMatchObject({ exists: true, dead: true });
		const observed = await first.supervisor.poll({
			process_id: String(started.process_id),
			stdout_cursor: 0,
			stderr_cursor: 0,
			wait_ms: 0,
			max_bytes: 64 * 1024,
		});
		expect(observed.stdout).toContain("GOT:fresh");
		first.db.close();
	});
});
