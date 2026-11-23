import { asHostSpanError, HostSpanError } from "../errors.js";
import type { ProcessStartToolInput } from "../tools/schemas.js";
import type { InteractiveSessionManager } from "./interactive-session.js";
import type { ProcessSnapshot } from "./snapshot.js";
import type { ProcessSupervisorOptions } from "./supervisor.js";
import type { ProcessState } from "./store.js";

export interface WorkerLaunchContext {
	options: ProcessSupervisorOptions;
	input: ProcessStartToolInput;
	requestId: string;
	processId: string;
	session: string;
	sessionManager: InteractiveSessionManager;
	backend: "pty" | "native";
	cwd: { absolute: string; relative: string };
	effectiveMaxOutputBytes: number;
	deadlineAt: string | null;
	responseBytes: number;
	expiresAt(): string;
	finalize(
		processId: string,
		state: ProcessState,
		exitCode: number | null,
		signal: string | null,
		reason: string | null,
		endedAt?: string,
	): void;
	snapshot(
		processId: string,
		stdoutCursor: number,
		stderrCursor: number,
		maxBytes: number,
	): ProcessSnapshot;
	syncSessionState(processId: string): Promise<void>;
}

export async function launchWorkerBackedProcess({
	options,
	input,
	requestId,
	processId,
	session,
	sessionManager,
	backend,
	cwd,
	effectiveMaxOutputBytes,
	deadlineAt,
	responseBytes,
	expiresAt,
	finalize,
	snapshot,
	syncSessionState,
}: WorkerLaunchContext): Promise<ProcessSnapshot> {
	let started: { session: string; pid: number | null };
	try {
		started = await sessionManager.start({
			processId,
			cwd: cwd.absolute,
			argv: input.argv,
			env: input.env,
			columns: input.columns ?? 120,
			rows: input.rows ?? 40,
			deadlineAt,
			maxOutputBytes: effectiveMaxOutputBytes,
		});
	} catch (error) {
		if (
			backend === "native" &&
			asHostSpanError(error).code === "PROCESS_UNKNOWN"
		) {
			options.operations.setState(input.idempotency_key, "unknown", {
				state: "unknown",
				process_id: processId,
				reason: "native_worker_start_unconfirmed",
			});
			throw new HostSpanError(
				"PROCESS_UNKNOWN",
				"Native worker launch is not yet confirmed; recover the existing process_id instead of starting it again.",
				false,
				{ process_id: processId },
			);
		}
		options.processes.markTerminal(
			processId,
			"failed",
			null,
			null,
			`${backend}_start_failed`,
			expiresAt(),
		);
		options.operations.setState(
			input.idempotency_key,
			"failed",
			{
				state: "failed",
				process_id: processId,
				reason: `${backend}_start_failed`,
			},
			error,
		);
		throw error;
	}
	const launchState = await sessionManager.inspect(session);
	if (!launchState.exists) {
		finalize(
			processId,
			"unknown",
			null,
			null,
			"interactive_session_missing_after_launch",
		);
		return snapshot(processId, 0, 0, responseBytes);
	}
	if (launchState.dead) {
		await syncSessionState(processId);
		return snapshot(processId, 0, 0, responseBytes);
	}
	if (
		!options.processes.markRunning(
			processId,
			started.pid,
			backend === "native" && process.platform !== "win32" ? started.pid : null,
		)
	) {
		const current = options.processes.get(processId);
		// Reconciliation may already have accepted this exact child while start awaited its worker.
		if (
			current?.state !== "running" ||
			current.backend_ref !== session ||
			current.pid !== started.pid
		) {
			sessionManager.closeSync(session);
			if (!current)
				throw new HostSpanError(
					"PROCESS_UNKNOWN",
					"Process record disappeared during launch.",
				);
			return snapshot(processId, 0, 0, responseBytes);
		}
	}
	options.operations.setState(input.idempotency_key, "running", {
		state: "running",
		process_id: processId,
		backend,
	});
	options.logger?.info("process.started", {
		request_id: requestId,
		process_id: processId,
		pid: started.pid,
		backend,
		session,
	});
	const beforeBytes =
		sessionManager.outputBytes(processId) +
		(backend === "native"
			? sessionManager.outputBytes(processId, "stderr")
			: 0);
	await sessionManager.waitForActivity(
		session,
		processId,
		beforeBytes,
		input.wait_ms,
	);
	await syncSessionState(processId);
	return snapshot(processId, 0, 0, responseBytes);
}
