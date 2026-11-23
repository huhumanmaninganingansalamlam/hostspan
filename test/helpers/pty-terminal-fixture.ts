import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { PolicyEvaluator } from "../../src/policy/evaluator.js";
import { ptySocketPath } from "../../src/processes/pty-ipc.js";
import { PtySessionManager } from "../../src/processes/pty-session.js";
import { ProcessSupervisor } from "../../src/processes/supervisor.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";
import { TargetRegistry } from "../../src/targets/registry.js";

export interface PtyTerminalFixtureOptions {
	terminalCapability?: boolean;
	maxConcurrentSessions?: number;
	requireOwnership?: boolean;
	listenPort?: number;
}

export interface PtyTerminalFixture {
	root: string;
	configPath: string;
	config: HostSpanConfig;
	db: ReturnType<typeof openDatabase>;
	operations: OperationsRepo;
	processes: ProcessesRepo;
	targets: TargetRegistry;
	terminal: PtySessionManager;
	supervisor: ProcessSupervisor;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function ttyInput(script: string, deadlineMs = 10_000, waitMs = 300) {
	return {
		idempotency_key: uuidv7(),
		target_id: "test",
		argv: ["node", "-e", script],
		cwd: ".",
		env: {},
		wait_ms: waitMs,
		deadline_ms: deadlineMs,
		max_output_bytes: 1024 * 1024,
		tty: true,
		columns: 100,
		rows: 30,
	};
}

export async function unusedTcpPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("test port fixture did not return a TCP port");
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	return address.port;
}

/** Owns every temporary root, database, PTY session, and raw socket created by one test file. */
export class PtyTerminalTestContext {
	readonly #roots: string[] = [];
	readonly #sessions: Array<{ terminal: PtySessionManager; session: string }> =
		[];
	readonly #attachments: Socket[] = [];
	readonly #databases: Array<ReturnType<typeof openDatabase>> = [];

	createPtyTerminalFixture(
		options: PtyTerminalFixtureOptions = {},
	): PtyTerminalFixture {
		const {
			terminalCapability = true,
			maxConcurrentSessions = 2,
			requireOwnership = false,
			listenPort = 39393,
		} = options;
		const root = mkdtempSync(join(tmpdir(), "hostspan-pty-"));
		this.#roots.push(root);
		const targetRoot = join(root, "target");
		const dataDir = join(root, "state");
		mkdirSync(targetRoot, { recursive: true });
		const config: HostSpanConfig = {
			schema_version: 1,
			policy_epoch: 1,
			server: {
				listen_host: "127.0.0.1",
				listen_port: listenPort,
				data_dir: dataDir,
			},
			retention: {
				completed_process_output_ttl_minutes: 60,
				operation_result_days: 14,
				audit_days: 30,
				max_total_spool_bytes: 64 * 1024 * 1024,
			},
			terminal: {
				backend: "pty",
				max_concurrent_sessions: maxConcurrentSessions,
				attach_history_bytes: 64 * 1024,
				max_output_bytes: 1024 * 1024,
			},
			targets: {
				test: {
					label: "Test",
					provider: "local",
					root: targetRoot,
					capabilities: terminalCapability
						? ["read", "exec", "terminal"]
						: ["read", "exec"],
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
		const configPath = join(root, "config.yaml");
		writeConfigAtomic(configPath, config);
		const db = openDatabase(join(dataDir, "state.db"));
		this.#databases.push(db);
		const operations = new OperationsRepo(db);
		const processes = new ProcessesRepo(db);
		const targets = new TargetRegistry(config);
		const terminalConfig = config.terminal;
		if (!terminalConfig)
			throw new Error("terminal fixture configuration is missing");
		const terminal = new PtySessionManager(dataDir, terminalConfig, {
			requireOwnership,
			configPath,
		});
		const supervisor = new ProcessSupervisor({
			config,
			targets,
			policy: new PolicyEvaluator(config),
			operations,
			processes,
			terminal,
		});
		return {
			root,
			configPath,
			config,
			db,
			operations,
			processes,
			targets,
			terminal,
			supervisor,
		};
	}

	trackSession(
		terminal: PtySessionManager,
		started: Record<string, unknown>,
	): string {
		const session = String(started.terminal_session);
		this.trackSessionName(terminal, session);
		return session;
	}

	trackSessionName(terminal: PtySessionManager, session: string): void {
		this.#sessions.push({ terminal, session });
	}

	replaceTrackedSessionManager(
		session: string,
		terminal: PtySessionManager,
	): void {
		const tracked = [...this.#sessions]
			.reverse()
			.find((entry) => entry.session === session);
		if (!tracked)
			throw new Error(
				`PTY session ${session} is not tracked by this test context`,
			);
		tracked.terminal = terminal;
	}

	async openRawAttachment(
		dataDir: string,
		session: string,
		readOnly: boolean,
		ownerGeneration?: number,
		initialInput?: Buffer,
	): Promise<{ socket: Socket; output(): string }> {
		const status = JSON.parse(
			readFileSync(join(dataDir, "sessions", session, "status.json"), "utf8"),
		) as { ipc_token?: string };
		if (!status.ipc_token)
			throw new Error("PTY attachment fixture is missing ipc_token");
		const socket = createConnection(ptySocketPath(dataDir, session));
		this.#attachments.push(socket);
		const output: Buffer[] = [];
		await new Promise<void>((resolveAttach, rejectAttach) => {
			let header = Buffer.alloc(0);
			const onError = (error: Error) => rejectAttach(error);
			const onData = (chunk: Buffer) => {
				header = Buffer.concat([header, chunk]);
				const newline = header.indexOf(10);
				if (newline < 0) return;
				const response = JSON.parse(
					header.subarray(0, newline).toString("utf8"),
				) as { ok?: boolean; error?: string };
				if (!response.ok) {
					rejectAttach(new Error(response.error ?? "raw PTY attach failed"));
					return;
				}
				const rest = header.subarray(newline + 1);
				if (rest.length) output.push(rest);
				socket.off("error", onError);
				socket.off("data", onData);
				socket.on("data", (data) => output.push(Buffer.from(data)));
				resolveAttach();
			};
			socket.once("error", onError);
			socket.on("data", onData);
			socket.once("connect", () => {
				const request = Buffer.from(
					`${JSON.stringify({
						op: "attach",
						read_only: readOnly,
						token: status.ipc_token,
						...(ownerGeneration === undefined
							? {}
							: { owner_generation: ownerGeneration }),
					})}\n`,
				);
				socket.write(
					initialInput ? Buffer.concat([request, initialInput]) : request,
				);
			});
		});
		return { socket, output: () => Buffer.concat(output).toString("utf8") };
	}

	async dispose(): Promise<void> {
		for (const socket of this.#attachments.splice(0)) socket.destroy();
		for (const entry of this.#sessions.splice(0))
			entry.terminal.closeSync(entry.session);
		for (const db of this.#databases.splice(0)) {
			try {
				if (db.open) db.close();
			} catch {
				// Test cleanup should not hide the primary assertion failure.
			}
		}
		await sleep(100);
		for (const root of this.#roots.splice(0)) {
			for (let attempt = 0; attempt < 40; attempt += 1) {
				try {
					rmSync(root, { recursive: true, force: true });
					break;
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					const retryable =
						code === "EPERM" ||
						(process.platform === "win32" &&
							(code === "EBUSY" || code === "EACCES"));
					if (!retryable || attempt === 39) throw error;
					await sleep(25);
				}
			}
		}
	}
}
