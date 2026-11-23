import type { ProcessSupervisorOptions, RuntimeProcess } from "./supervisor.js";
import { TERMINAL_STATES } from "./state-machine.js";
import type { ProcessState } from "./store.js";

export function completeProcess(
	options: ProcessSupervisorOptions,
	runtimes: Map<string, RuntimeProcess>,
	outputExpiresAt: () => string,
	processId: string,
	state: ProcessState,
	exitCode: number | null,
	signal: string | null,
	reason: string | null,
	endedAt?: string,
): void {
	const current = options.processes.get(processId);
	if (!current || TERMINAL_STATES.has(current.state)) {
		const runtime = runtimes.get(processId);
		if (runtime?.deadlineTimer) clearTimeout(runtime.deadlineTimer);
		runtime?.resolveTerminal();
		runtimes.delete(processId);
		return;
	}
	const expiresAt = outputExpiresAt();
	options.processes.markTerminal(
		processId,
		state,
		exitCode,
		signal,
		reason,
		expiresAt,
		endedAt,
	);
	const result = {
		state,
		process_id: processId,
		exit_code: exitCode,
		signal,
		reason,
		output_expires_at: expiresAt,
		native_execution: true,
		sandboxed: false,
	};
	options.operations.setState(current.idempotency_key, state, result);
	options.logger?.info("process.completed", {
		process_id: processId,
		state,
		exit_code: exitCode,
		signal,
		reason,
	});
	const runtime = runtimes.get(processId);
	if (runtime?.deadlineTimer) clearTimeout(runtime.deadlineTimer);
	runtime?.resolveTerminal();
	runtimes.delete(processId);
}
