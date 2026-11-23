import { HostSpanError } from "../errors.js";
import type { InteractiveSessionManager } from "./interactive-session.js";
import { TERMINAL_STATES } from "./state-machine.js";
import type { ProcessRecord, ProcessState } from "./store.js";
import type { ProcessSupervisorOptions, RuntimeProcess } from "./supervisor.js";
import { processGroupAlive, signalProcessGroup } from "./recovery.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForGroupGone(
	pgid: number,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (!processGroupAlive(pgid)) return true;
		await sleep(20);
	}
	return !processGroupAlive(pgid);
}

async function waitForWindowsProcessGone(
	pid: number | null,
	timeoutMs: number,
): Promise<boolean> {
	if (process.platform !== "win32" || !pid || pid <= 0) return true;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await sleep(20);
	}
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}

export function safeKillGroup(
	pgid: number | null,
	signal: NodeJS.Signals,
): void {
	signalProcessGroup(pgid, signal);
}

export interface WorkerTerminationContext {
	options: ProcessSupervisorOptions;
	sessionManager(record: ProcessRecord): InteractiveSessionManager | undefined;
	finalize(
		processId: string,
		state: ProcessState,
		exitCode: number | null,
		signal: string | null,
		reason: string | null,
		endedAt?: string,
	): void;
	syncOutput(record: ProcessRecord, manager: InteractiveSessionManager): void;
}
export async function terminateWorkerSession(
	{ options, sessionManager, finalize, syncOutput }: WorkerTerminationContext,
	processId: string,
	state: "timed_out" | "cancelled" | "failed",
	reason: string,
	graceMs = 500,
): Promise<ProcessState> {
	const record = options.processes.get(processId);
	if (!record)
		throw new HostSpanError(
			"PROCESS_NOT_FOUND",
			`Unknown process_id: ${processId}`,
		);
	if (TERMINAL_STATES.has(record.state)) return record.state;
	const manager = sessionManager(record);
	if (!manager || !record.backend_ref) {
		finalize(
			processId,
			"unknown",
			record.exit_code,
			record.term_signal,
			"interactive_backend_unavailable",
		);
		return "unknown";
	}
	await manager.close(record.backend_ref, graceMs);
	const settled = await manager.waitForExitStatus(record.backend_ref, 250);
	if (!settled.exists) {
		finalize(
			processId,
			"unknown",
			record.exit_code,
			record.term_signal,
			"interactive_session_missing_after_terminate",
		);
		return "unknown";
	}
	if (!settled.dead) {
		finalize(
			processId,
			"unknown",
			record.exit_code,
			record.term_signal,
			"interactive_session_still_running_after_terminate",
		);
		return "unknown";
	}
	if (settled.reason === "termination_unconfirmed") {
		finalize(
			processId,
			"unknown",
			settled.exit_code,
			settled.signal,
			settled.reason,
		);
		return "unknown";
	}
	finalize(
		processId,
		state,
		settled.exit_code,
		settled.signal,
		reason,
		settled.ended_at,
	);
	// Confirmed process death survives a failure to observe the final output.
	await manager.waitForOutputDrain(processId);
	syncOutput(record, manager);
	return state;
}
export interface DirectTerminationContext {
	options: ProcessSupervisorOptions;
	runtimes: Map<string, RuntimeProcess>;
	finalize(
		processId: string,
		state: ProcessState,
		exitCode: number | null,
		signal: string | null,
		reason: string | null,
	): void;
}
export async function terminateProcessTree(
	{ options, runtimes, finalize }: DirectTerminationContext,
	processId: string,
	state: "timed_out" | "cancelled" | "failed",
	reason: string,
	graceMs: number,
): Promise<ProcessState> {
	const record = options.processes.get(processId);
	if (!record)
		throw new HostSpanError(
			"PROCESS_NOT_FOUND",
			`Unknown process_id: ${processId}`,
		);
	if (TERMINAL_STATES.has(record.state)) return record.state;
	const runtime = runtimes.get(processId);
	if (runtime) runtime.terminating = true;
	let gone: boolean;
	try {
		safeKillGroup(record.pgid, "SIGTERM");
		gone = record.pgid ? await waitForGroupGone(record.pgid, graceMs) : true;
		if (!gone) {
			safeKillGroup(record.pgid, "SIGKILL");
			gone = record.pgid ? await waitForGroupGone(record.pgid, 1_000) : true;
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown";
		finalize(
			processId,
			"unknown",
			record.exit_code,
			record.term_signal,
			`${reason}:termination_error:${code}`,
		);
		return "unknown";
	}
	if (runtime) {
		// Process-tree death and Node stdio closure are separate facts. Do not
		// return a terminal result while stdout/stderr callbacks can still touch
		// durable state. A short grace normally observes `close`; if Node keeps
		// the pipe handles alive after the OS process tree is gone, stop
		// accepting output, destroy the pipes, and classify the boundary as
		// unknown unless close is then observed.
		await Promise.race([runtime.closed, sleep(2_000)]);
		if (!runtime.closedObserved) {
			runtime.acceptingOutput = false;
			runtime.child.stdout.destroy();
			runtime.child.stderr.destroy();
			await Promise.race([runtime.closed, sleep(500)]);
			if (!runtime.closedObserved) {
				finalize(
					processId,
					"unknown",
					runtime.exitCode,
					runtime.exitSignal,
					`${reason}:stdio_close_unconfirmed`,
				);
				return "unknown";
			}
		}
	}
	const windowsTargetGone = await waitForWindowsProcessGone(record.pid, 1_500);
	if (process.platform === "win32" && windowsTargetGone) {
		// Job Object termination is kernel-owned, but process teardown can
		// release cwd/file handles a moment after the target PID disappears.
		// Do not return cancellation while ordinary follow-up file operations
		// are still racing that teardown.
		await sleep(100);
	}
	const refreshedRuntime = runtimes.get(processId);
	const exitCode =
		refreshedRuntime?.exitCode ??
		options.processes.get(processId)?.exit_code ??
		null;
	const signal =
		refreshedRuntime?.exitSignal ??
		options.processes.get(processId)?.term_signal ??
		null;
	if (!gone) {
		finalize(
			processId,
			"orphaned",
			exitCode,
			signal,
			`${reason}:process_group_still_alive`,
		);
		return "orphaned";
	}
	if (!windowsTargetGone) {
		finalize(
			processId,
			"orphaned",
			exitCode,
			signal,
			`${reason}:windows_job_target_still_alive`,
		);
		return "orphaned";
	}
	finalize(processId, state, exitCode, signal, reason);
	return state;
}
