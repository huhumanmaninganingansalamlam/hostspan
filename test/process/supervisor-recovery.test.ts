import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { HostSpanError } from "../../src/errors.js";
import { TerminalConfigSchema } from "../../src/config/schema.js";
import { createRuntime } from "../../src/runtime/create-runtime.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import type { InteractiveSessionManager } from "../../src/processes/interactive-session.js";
import { ProcessSupervisor } from "../../src/processes/supervisor.js";
import { PtySessionManager } from "../../src/processes/pty-session.js";
import { PolicyEvaluator } from "../../src/policy/evaluator.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { TargetRegistry } from "../../src/targets/registry.js";
import {
	ProcessSupervisorTestContext,
	processStartInput,
	pollProcessUntilTerminal,
} from "../helpers/process-supervisor-fixture.js";

const processFixtures = new ProcessSupervisorTestContext();

afterEach(async () => {
	await processFixtures.dispose();
});

describe("process supervisor recovery", () => {
	it("keeps an unconfirmed native worker launch recoverable without replaying it", async () => {
		const { config, processes, operations } =
			processFixtures.createProcessSupervisorFixture();
		const targets = new TargetRegistry(config);
		const native = {
			sessionName: (id: string) => id,
			start: vi.fn(async () => {
				throw new HostSpanError(
					"PROCESS_UNKNOWN",
					"worker startup wait elapsed",
				);
			}),
			inspect: async () => ({ exists: false }),
			outputBytes: () => 0,
		} as unknown as InteractiveSessionManager;
		const supervisor = new ProcessSupervisor({
			config,
			targets,
			processes,
			operations,
			policy: new PolicyEvaluator(config),
			native,
		});
		const input = processStartInput();
		await expect(
			supervisor.start(input, "req_native_uncertain"),
		).rejects.toMatchObject({
			code: "PROCESS_UNKNOWN",
			details: { process_id: expect.any(String) },
		});
		expect(processes.getByKey(input.idempotency_key)).toMatchObject({
			state: "launching",
			backend: "native",
			backend_ref: expect.any(String),
			output_expires_at: null,
		});
		expect(
			await supervisor.start(input, "req_native_uncertain_replay"),
		).toMatchObject({ state: "launching" });
		expect(native.start).toHaveBeenCalledTimes(1);
		expect(operations.getState(input.idempotency_key)).toBe("unknown");
	});

	it("preserves native stdout/stderr and final exit across daemon replacement without terminal capability", async () => {
		const { config, targetRoot } =
			processFixtures.createProcessSupervisorFixture();
		const configPath = join(config.server.data_dir, "config.yaml");
		writeConfigAtomic(configPath, config);
		let runtime = createRuntime(configPath);
		const manager = new PtySessionManager(
			config.server.data_dir,
			TerminalConfigSchema.parse({}),
			{ backend: "native" },
		);
		const stale = new PtySessionManager(
			config.server.data_dir,
			TerminalConfigSchema.parse({}),
			{ backend: "native", requireOwnership: true },
		);
		const generation = manager.currentOwnerGeneration();
		if (generation === null)
			throw new Error("native ownership was not activated");
		stale.activateOwnership(generation);
		const { deadline_ms: _deadline, ...input } = processStartInput({
			argv: [
				process.execPath,
				"-e",
				"const fs=require('node:fs');fs.appendFileSync('starts','1');process.stdout.write('before-out\\n');process.stderr.write('before-err\\n');const t=setInterval(()=>{if(fs.existsSync('finish')){clearInterval(t);process.stdout.write('after-out\\n');process.stderr.write('after-err\\n');process.exitCode=7}},20)",
			],
			wait_ms: 0,
		});
		try {
			const started = await runtime.supervisor.start(
				input,
				"req_native_durable",
			);
			const id = String(started.process_id);
			processFixtures.trackNativeSession(manager, id);
			expect(started).toMatchObject({ backend: "native", interactive: false });
			expect(started).not.toHaveProperty("terminal_session");
			expect(runtime.processes.get(id)?.backend_ref).toBe(id);
			await expect.poll(() => manager.outputBytes(id)).toBeGreaterThan(0);
			await runtime.supervisor.shutdown();
			await runtime.close();
			expect(manager.inspectSync(id)).toMatchObject({
				exists: true,
				dead: false,
			});

			runtime = createRuntime(configPath);
			expect(runtime.processes.get(id)?.state).toBe("running");
			await expect(stale.close(id)).rejects.toMatchObject({
				code: "SERVER_BUSY",
				details: { reason: "stale_runtime_owner" },
			});
			await expect(
				runtime.supervisor.write({
					process_id: id,
					idempotency_key: uuidv7(),
					chars: "x",
					control_keys: [],
					stdout_cursor: 0,
					wait_ms: 0,
					max_bytes: 100,
				}),
			).rejects.toMatchObject({ code: "TERMINAL_NOT_INTERACTIVE" });
			const replay = await runtime.supervisor.start(input, "req_native_replay");
			expect(replay.process_id).toBe(id);
			expect(readFileSync(join(targetRoot, "starts"), "utf8")).toBe("1");
			await runtime.supervisor.shutdown();
			await runtime.close();
			writeFileSync(join(targetRoot, "finish"), "finish");
			await expect(manager.waitForExitStatus(id, 5_000)).resolves.toMatchObject(
				{ exists: true, dead: true, exit_code: 7 },
			);
			runtime = createRuntime(configPath);
			const result = await pollProcessUntilTerminal(runtime.supervisor, id);
			expect(result).toMatchObject({
				state: "failed",
				exit_code: 7,
				stdout: "before-out\nafter-out\n",
				stderr: "before-err\nafter-err\n",
			});
		} finally {
			await runtime.close();
		}
	});

	it("enforces the original native deadline while the daemon is absent and recovers the final output", async () => {
		const { config } = processFixtures.createProcessSupervisorFixture();
		const configPath = join(config.server.data_dir, "config.yaml");
		writeConfigAtomic(configPath, config);
		let runtime = createRuntime(configPath);
		const manager = new PtySessionManager(
			config.server.data_dir,
			TerminalConfigSchema.parse({}),
			{ backend: "native" },
		);
		try {
			const started = await runtime.supervisor.start(
				processStartInput({
					argv: [
						process.execPath,
						"-e",
						"process.stdout.write('deadline-out');process.stderr.write('deadline-err');setInterval(()=>{},1000)",
					],
					deadline_ms: 10_000,
					wait_ms: 0,
				}),
				"req_native_deadline",
			);
			const id = String(started.process_id);
			processFixtures.trackNativeSession(manager, id);
			await expect
				.poll(
					() =>
						manager.outputBytes(id) > 0 &&
						manager.outputBytes(id, "stderr") > 0,
					{ timeout: 8_000 },
				)
				.toBe(true);
			await runtime.supervisor.shutdown();
			await runtime.close();
			await expect(
				manager.waitForExitStatus(id, 15_000),
			).resolves.toMatchObject({
				exists: true,
				dead: true,
				reason: "deadline_exceeded",
			});
			runtime = createRuntime(configPath);
			expect(
				await runtime.supervisor.poll({
					process_id: id,
					stdout_cursor: 0,
					stderr_cursor: 0,
					wait_ms: 0,
					max_bytes: 1024,
				}),
			).toMatchObject({
				state: "timed_out",
				stdout: "deadline-out",
				stderr: "deadline-err",
				deadline_at: started.deadline_at,
			});
		} finally {
			await runtime.close();
		}
	});

	it("cancels a durable native process through the recovered worker", async () => {
		const { config } = processFixtures.createProcessSupervisorFixture();
		const configPath = join(config.server.data_dir, "config.yaml");
		writeConfigAtomic(configPath, config);
		let runtime = createRuntime(configPath);
		const manager = new PtySessionManager(
			config.server.data_dir,
			TerminalConfigSchema.parse({}),
			{ backend: "native" },
		);
		try {
			const descendant =
				"process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid));setInterval(()=>{},1000)";
			const script = `process.on('SIGTERM',()=>{});require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
			const started = await runtime.supervisor.start(
				processStartInput({
					argv: [process.execPath, "-e", script],
					wait_ms: 0,
				}),
				"req_native_cancel",
			);
			const id = String(started.process_id);
			processFixtures.trackNativeSession(manager, id);
			await expect
				.poll(() => manager.outputBytes(id), { timeout: 10_000 })
				.toBeGreaterThan(0);
			await runtime.supervisor.shutdown();
			await runtime.close();
			runtime = createRuntime(configPath);
			expect(manager.outputBytes(id)).toBeGreaterThan(0);
			const before = await runtime.supervisor.poll({
				process_id: id,
				stdout_cursor: 0,
				stderr_cursor: 0,
				wait_ms: 0,
				max_bytes: 1024,
			});
			const descendantPid = Number(before.stdout);
			expect(descendantPid).toBeGreaterThan(0);
			const input = {
				process_id: id,
				idempotency_key: uuidv7(),
				grace_ms: 100,
			};
			expect(await runtime.supervisor.cancel(input)).toMatchObject({
				state: "cancelled",
				process_id: id,
			});
			expect(await runtime.supervisor.cancel(input)).toMatchObject({
				state: "cancelled",
				process_id: id,
			});
			expect(manager.inspectSync(id)).toMatchObject({
				exists: true,
				dead: true,
			});
			await expect
				.poll(() => {
					try {
						process.kill(descendantPid, 0);
						return true;
					} catch {
						return false;
					}
				})
				.toBe(false);
		} finally {
			await runtime.close();
		}
	});

	it("recovers native crash-boundary records after activation with PTY disabled", async () => {
		const { config, processes, db } =
			processFixtures.createProcessSupervisorFixture();
		const configPath = join(config.server.data_dir, "config.yaml");
		writeConfigAtomic(configPath, config);
		const key = uuidv7();
		const input = { target_id: "test", idempotency_key: key, argv: ["node"] };
		new OperationsRepo(db).resolve(key, "process_start", input, "test");
		processes.create({
			process_id: "proc_crashed",
			idempotency_key: key,
			target_id: "test",
			argv_digest: "sha256:test",
			cwd_relative: ".",
		});
		const runtime = createRuntime(configPath, { deferActivation: true });
		try {
			expect(runtime.processes.get("proc_crashed")?.state).toBe("launching");
			runtime.activate();
			expect(runtime.processes.get("proc_crashed")?.state).toBe("unknown");
			expect(runtime.processes.activeCount()).toBe(0);
			expect(
				runtime.operations.resolve(key, "process_start", input, "test").kind,
			).toBe("unknown");
		} finally {
			await runtime.close();
		}
	});
});
