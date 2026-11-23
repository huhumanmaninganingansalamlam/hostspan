import { spawn } from "node:child_process";
import { HostSpanError } from "../errors.js";
import type { ProcessStartToolInput } from "../tools/schemas.js";
import { processEnvironment } from "./environment.js";
import { OutputSpool } from "./output-spool.js";
import {
	spawnWindowsJobProcess,
	type WindowsJobReceipt,
} from "./windows-job-process.js";
import type {
	ProcessSupervisorOptions,
	RuntimeProcess,
	SupervisedChild,
} from "./supervisor.js";
import { TERMINAL_STATES } from "./state-machine.js";
import type { ProcessSnapshot } from "./snapshot.js";
import type { ProcessState } from "./store.js";

export interface DirectNativeLaunchContext {
	options: ProcessSupervisorOptions;
	input: ProcessStartToolInput;
	requestId: string;
	processId: string;
	cwd: { absolute: string; relative: string };
	effectiveMaxOutputBytes: number;
	deadlineAt: string | null;
	responseBytes: number;
	runtimes: Map<string, RuntimeProcess>;
	expiresAt(): string;
	finalize(
		processId: string,
		state: ProcessState,
		exitCode: number | null,
		signal: string | null,
		reason: string | null,
	): void;
	terminate(
		processId: string,
		state: "timed_out" | "cancelled" | "failed",
		reason: string,
		graceMs: number,
	): Promise<ProcessState>;
	waitForTerminal(processId: string, waitMs: number): Promise<void>;
	snapshot(
		processId: string,
		stdoutCursor: number,
		stderrCursor: number,
		maxBytes: number,
	): ProcessSnapshot;
}

export async function launchDirectNativeProcess({
	options,
	input,
	requestId,
	processId,
	cwd,
	effectiveMaxOutputBytes,
	deadlineAt,
	responseBytes,
	runtimes,
	expiresAt,
	finalize,
	terminate,
	waitForTerminal,
	snapshot,
}: DirectNativeLaunchContext): Promise<ProcessSnapshot> {
	let child: SupervisedChild;
	let windowsReady: Promise<WindowsJobReceipt> | undefined;
	try {
		const env = processEnvironment(input.env);
		const program = input.argv[0];
		if (!program)
			throw new HostSpanError(
				"SCOPE_DENIED",
				"Process argv must include a program.",
			);
		if (process.platform === "win32") {
			const launched = spawnWindowsJobProcess({
				dataDir: options.config.server.data_dir,
				processId,
				cwd: cwd.absolute,
				argv: input.argv,
				env,
			});
			child = launched.child;
			windowsReady = launched.ready;
		} else {
			child = spawn(program, input.argv.slice(1), {
				cwd: cwd.absolute,
				env,
				shell: false,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		}
	} catch (error) {
		options.processes.markTerminal(
			processId,
			"failed",
			null,
			null,
			"spawn_failed",
			expiresAt(),
		);
		options.operations.setState(
			input.idempotency_key,
			"failed",
			{ state: "failed", process_id: processId, reason: "spawn_failed" },
			error,
		);
		throw error;
	}

	let resolveTerminal!: () => void;
	const terminal = new Promise<void>((resolve) => {
		resolveTerminal = resolve;
	});
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	const runtime: RuntimeProcess = {
		child,
		spool: new OutputSpool(
			options.config.server.data_dir,
			processId,
			effectiveMaxOutputBytes,
		),
		terminal,
		resolveTerminal,
		closed,
		resolveClosed,
		terminating: false,
		acceptingOutput: true,
		closedObserved: false,
		exitCode: null,
		exitSignal: null,
	};
	runtimes.set(processId, runtime);

	const onOutput = (stream: "stdout" | "stderr", chunk: Buffer): void => {
		if (!runtime.acceptingOutput) return;
		const current = options.processes.get(processId);
		if (!current || TERMINAL_STATES.has(current.state)) return;
		const written = runtime.spool.append(stream, chunk);
		if (written > 0) options.processes.addBytes(processId, stream, written);
	};
	child.stdout.on("data", (chunk: Buffer) => onOutput("stdout", chunk));
	child.stderr.on("data", (chunk: Buffer) => onOutput("stderr", chunk));

	const markRunning = (pid: number, groupId: number): void => {
		const current = options.processes.get(processId);
		if (!current || TERMINAL_STATES.has(current.state)) return;
		if (!options.processes.markRunning(processId, pid, groupId)) return;
		options.operations.setState(input.idempotency_key, "running", {
			state: "running",
			process_id: processId,
		});
		options.logger?.info("process.started", {
			request_id: requestId,
			process_id: processId,
			pid,
			pgid: groupId,
		});
		if (input.deadline_ms !== undefined) {
			runtime.deadlineTimer = setTimeout(() => {
				void terminate(
					processId,
					"timed_out",
					"deadline_exceeded",
					process.platform === "win32" ? 0 : 1_000,
				);
			}, input.deadline_ms);
			runtime.deadlineTimer.unref();
		}
	};

	child.once("error", (error) => {
		runtime.closedObserved = true;
		runtime.resolveClosed();
		if (runtime.terminating) return;
		runtime.terminating = true;
		finalize(processId, "failed", null, null, `spawn_error:${error.message}`);
	});

	child.once("close", (code, signal) => {
		runtime.closedObserved = true;
		runtime.exitCode = code;
		runtime.exitSignal = signal;
		runtime.resolveClosed();
		if (runtime.terminating) return;
		const state: ProcessState = code === 0 ? "succeeded" : "failed";
		finalize(
			processId,
			state,
			code,
			signal,
			code === 0 ? null : "nonzero_exit",
		);
	});

	if (windowsReady) {
		try {
			const receipt = await windowsReady;
			markRunning(receipt.targetPid, receipt.workerPid);
		} catch (error) {
			runtime.terminating = true;
			if (child.pid) {
				try {
					process.kill(child.pid, "SIGKILL");
				} catch {
					// The worker may already have exited after reporting launch failure.
				}
			}
			const current = options.processes.get(processId);
			if (current && !TERMINAL_STATES.has(current.state)) {
				finalize(
					processId,
					"failed",
					null,
					null,
					`spawn_error:${error instanceof Error ? error.message : String(error)}`,
				);
			}
			throw error;
		}
	} else if (child.pid) {
		// spawn() already returned the OS PID; record it before wait_ms=0 can expose a cancellable process.
		markRunning(child.pid, child.pid);
	}

	await waitForTerminal(processId, input.wait_ms);
	const afterWait = options.processes.get(processId);
	if (
		afterWait &&
		!TERMINAL_STATES.has(afterWait.state) &&
		deadlineAt !== null &&
		deadlineAt <= new Date().toISOString()
	) {
		await terminate(
			processId,
			"timed_out",
			"deadline_exceeded",
			process.platform === "win32" ? 0 : 1_000,
		);
	}
	return snapshot(processId, 0, 0, responseBytes);
}
