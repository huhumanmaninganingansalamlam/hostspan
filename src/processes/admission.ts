import type { ProcessStartToolInput } from "../tools/schemas.js";
import type { InteractiveSessionManager } from "./interactive-session.js";
import type { ProcessSupervisorOptions } from "./supervisor.js";
import { resolveTargetPath } from "../targets/path.js";
import { HostSpanError } from "../errors.js";
import { assertProcessSpoolBudget } from "./spool-admission.js";

export interface ProcessAdmission {
	interactive: boolean;
	responseBytes: number;
	cwd: ReturnType<typeof resolveTargetPath>;
	sessionManager: InteractiveSessionManager | undefined;
	backend: "native" | "pty";
	effectiveMaxOutputBytes: number;
}

export async function resolveProcessAdmission(
	options: ProcessSupervisorOptions,
	input: ProcessStartToolInput,
	reconcileInteractiveProcesses: (targetId: string) => Promise<void>,
): Promise<ProcessAdmission> {
	const interactive = input.tty ?? false;
	const responseBytes = input.max_bytes ?? 131_072;
	const target = options.targets.get(
		input.target_id,
		interactive ? "terminal" : "exec",
	);
	const cwd = resolveTargetPath(target, input.cwd);
	if (!cwd.exists)
		throw new HostSpanError(
			"FILE_NOT_FOUND",
			`Process cwd does not exist: ${input.cwd}`,
		);
	const profile = interactive
		? undefined
		: options.policy.validateExec(target, input.argv);
	if (
		options.native ||
		(interactive && options.terminal && options.config.terminal)
	) {
		await reconcileInteractiveProcesses(input.target_id);
	}
	const sessionManager = interactive ? options.terminal : options.native;
	const terminalConfig = options.config.terminal;
	const backend = interactive ? "pty" : "native";
	let effectiveMaxOutputBytes = input.max_output_bytes;
	// Check capacity before accepting new work; no await separates admission and reservation.
	if (options.operations.getState(input.idempotency_key) === undefined) {
		let maxConcurrent: number;
		let limitReason: string;
		if (interactive) {
			if (!sessionManager || !terminalConfig) {
				throw new HostSpanError(
					"TERMINAL_BACKEND_UNAVAILABLE",
					"Interactive terminal support is not configured.",
					true,
				);
			}
			maxConcurrent = terminalConfig.max_concurrent_sessions;
			limitReason = "max_concurrent_terminal_sessions";
			effectiveMaxOutputBytes = Math.min(
				effectiveMaxOutputBytes,
				terminalConfig.max_output_bytes,
			);
		} else {
			if (!profile)
				throw new HostSpanError(
					"POLICY_UNENFORCEABLE",
					"Missing native exec profile.",
				);
			maxConcurrent = profile.max_concurrent_processes;
			limitReason = "max_concurrent_processes";
		}
		const active = options.processes.active();
		const activeForTarget = active.filter(
			(record) =>
				record.target_id === input.target_id && record.backend === backend,
		).length;
		if (activeForTarget >= maxConcurrent) {
			throw new HostSpanError(
				"SERVER_BUSY",
				`Target ${input.target_id} reached ${limitReason}.`,
				true,
				{
					resource: "process",
					reason: limitReason,
					active: activeForTarget,
					max_concurrent: maxConcurrent,
				},
			);
		}
		assertProcessSpoolBudget(options.config, effectiveMaxOutputBytes, active);
	}
	return {
		interactive,
		responseBytes,
		cwd,
		sessionManager,
		backend,
		effectiveMaxOutputBytes,
	};
}
