import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { PolicyEvaluator } from "../../src/policy/evaluator.js";
import type { InteractiveSessionManager } from "../../src/processes/interactive-session.js";
import type { PtySessionManager } from "../../src/processes/pty-session.js";
import { ProcessSupervisor } from "../../src/processes/supervisor.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";
import { TargetRegistry } from "../../src/targets/registry.js";

export interface ProcessSupervisorFixtureOptions {
	maxTotalSpoolBytes?: number;
	terminal?: InteractiveSessionManager;
	completedOutputTtlMinutes?: number;
}

export interface ProcessSupervisorFixture {
	root: string;
	supervisor: ProcessSupervisor;
	processes: ProcessesRepo;
	operations: OperationsRepo;
	db: ReturnType<typeof openDatabase>;
	config: HostSpanConfig;
	targetRoot: string;
}

export function processStartInput(
	overrides: Partial<Parameters<ProcessSupervisor["start"]>[0]> = {},
) {
	return {
		idempotency_key: uuidv7(),
		target_id: "test",
		argv: ["node", "-e", "process.stdout.write('ok')"],
		cwd: ".",
		env: {},
		wait_ms: 1_200,
		deadline_ms: 5_000,
		max_output_bytes: 1024 * 1024,
		...overrides,
	};
}

export async function pollProcessUntilTerminal(
	supervisor: ProcessSupervisor,
	processId: string,
	timeoutMs = process.platform === "win32" ? 10_000 : 5_000,
): Promise<Record<string, unknown>> {
	const terminal = new Set([
		"succeeded",
		"failed",
		"timed_out",
		"cancelled",
		"orphaned",
		"unknown",
	]);
	const deadline = Date.now() + timeoutMs;
	let current: Record<string, unknown> = {
		state: "running",
		process_id: processId,
	};
	while (Date.now() < deadline) {
		current = await supervisor.poll({
			process_id: processId,
			stdout_cursor: 0,
			stderr_cursor: 0,
			wait_ms: 500,
			max_bytes: 1024,
		});
		if (terminal.has(String(current.state))) return current;
	}
	throw new Error(
		`process ${processId} did not reach a terminal state within ${timeoutMs}ms; last=${String(current.state)}`,
	);
}

// Startup is not the latency under test. Wait for actual bytes under the existing
// process deadline before measuring how quickly a poll returns unread output.
export async function waitForNativeProcessOutput(
	supervisor: ProcessSupervisor,
	processes: ProcessesRepo,
	processId: string,
	stream: "stdout" | "stderr",
): Promise<void> {
	while ((processes.get(processId)?.[`${stream}_bytes`] ?? 0) === 0) {
		const result = await supervisor.poll({
			process_id: processId,
			stdout_cursor: 0,
			stderr_cursor: 0,
			max_bytes: 1024,
			wait_ms: 100,
		});
		if (result.state !== "running")
			throw new Error(
				`process ${processId} became ${String(result.state)} before ${stream} output arrived`,
			);
	}
}

/** Owns temporary roots, databases, supervisors, and native PTY workers created by one test file. */
export class ProcessSupervisorTestContext {
	readonly #roots: string[] = [];
	readonly #databases: Array<ReturnType<typeof openDatabase>> = [];
	readonly #supervisors: ProcessSupervisor[] = [];
	readonly #nativeSessions: Array<{
		manager: PtySessionManager;
		session: string;
	}> = [];

	createProcessSupervisorFixture(
		options: ProcessSupervisorFixtureOptions = {},
	): ProcessSupervisorFixture {
		const {
			maxTotalSpoolBytes = 64 * 1024 * 1024,
			terminal,
			completedOutputTtlMinutes = 60,
		} = options;
		const root = mkdtempSync(join(tmpdir(), "hostspan-process-"));
		this.#roots.push(root);
		const targetRoot = join(root, "target");
		const dataDir = join(root, "state");
		mkdirSync(targetRoot, { recursive: true });
		const config: HostSpanConfig = {
			schema_version: 1,
			policy_epoch: 1,
			server: {
				listen_host: "127.0.0.1",
				listen_port: 39393,
				data_dir: dataDir,
			},
			retention: {
				completed_process_output_ttl_minutes: completedOutputTtlMinutes,
				operation_result_days: 14,
				audit_days: 30,
				max_total_spool_bytes: maxTotalSpoolBytes,
			},
			targets: {
				test: {
					label: "Test",
					provider: "local",
					root: targetRoot,
					capabilities: [
						"read",
						"write",
						"exec",
						...(terminal ? ["terminal" as const] : []),
					],
					exec_profile: "native-test",
					deny_globs: [],
					ignore_globs: [],
				},
			},
			exec_profiles: {
				"native-test": {
					mode: "native",
					max_concurrent_processes: 4,
				},
			},
		};
		const db = openDatabase(join(dataDir, "state.db"));
		this.#databases.push(db);
		const operations = new OperationsRepo(db);
		const processes = new ProcessesRepo(db);
		const targets = new TargetRegistry(config);
		const supervisor = new ProcessSupervisor({
			config,
			targets,
			policy: new PolicyEvaluator(config),
			operations,
			processes,
			...(terminal ? { terminal } : {}),
		});
		this.#supervisors.push(supervisor);
		return { root, supervisor, processes, operations, db, config, targetRoot };
	}

	trackRoot(root: string): void {
		this.#roots.push(root);
	}

	trackNativeSession(manager: PtySessionManager, session: string): void {
		this.#nativeSessions.push({ manager, session });
	}

	releaseSupervisor(supervisor: ProcessSupervisor): void {
		const index = this.#supervisors.indexOf(supervisor);
		if (index >= 0) this.#supervisors.splice(index, 1);
	}

	releaseDatabase(db: ReturnType<typeof openDatabase>): void {
		const index = this.#databases.indexOf(db);
		if (index >= 0) this.#databases.splice(index, 1);
	}

	async dispose(): Promise<void> {
		for (const { manager, session } of this.#nativeSessions.splice(0))
			manager.closeSync(session);
		for (const supervisor of this.#supervisors.splice(0))
			await supervisor.shutdown();
		for (const db of this.#databases.splice(0)) {
			try {
				if (db.open) db.close();
			} catch {
				// Test cleanup should not hide the primary assertion failure.
			}
		}
		for (const root of this.#roots.splice(0)) {
			for (let attempt = 0; attempt < 40; attempt += 1) {
				try {
					rmSync(root, { recursive: true, force: true });
					break;
				} catch (error) {
					if (
						(error as NodeJS.ErrnoException).code !== "EPERM" ||
						attempt === 39
					)
						throw error;
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			}
		}
	}
}
