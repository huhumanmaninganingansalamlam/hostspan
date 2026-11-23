import { TERMINAL_STATES } from "./state-machine.js";
import { HostSpanError } from "../errors.js";
import type { InteractiveSessionManager } from "./interactive-session.js";
import type { OutputSpool } from "./output-spool.js";
import type { ProcessRecord, ProcessState } from "./store.js";

export type ProcessOutputPage = {
	text: string;
	next_cursor: number;
	earliest_cursor: number;
	bytes_returned: number;
	dropped_bytes: number;
};

export type ProcessSnapshot = {
	state: ProcessState;
	process_id: string;
	target_id: string;
	cwd: string;
	exit_code_scope: "spawned_command";
	output_expired: boolean;
	has_more_output: boolean;
	stdout: string;
	stderr: string;
	next_stdout_cursor: number;
	next_stderr_cursor: number;
	stdout_dropped_bytes: number;
	stderr_dropped_bytes: number;
	stdout_earliest_cursor: number;
	stderr_earliest_cursor: number;
	exit_code: number | null;
	signal: string | null;
	reason: string | null;
	deadline_at: string | null;
	output_expires_at: string | null;
	backend: "native" | "pty";
	interactive: boolean;
	output_budget?: {
		scope: "retained_output";
		limit_bytes: number;
		used_bytes: number;
		remaining_bytes: number;
	};
	terminal_session?: string;
	human_attach_command?: string;
	human_attach_read_only_command?: string;
	native_execution: true;
	sandboxed: false;
};

export function buildProcessSnapshot(
	record: ProcessRecord,
	spool: OutputSpool,
	stdoutCursor: number,
	stderrCursor: number,
	maxBytes: number,
	terminal?: InteractiveSessionManager,
): ProcessSnapshot {
	const processId = record.process_id;
	const outputExpired = Boolean(
		record.output_expires_at &&
			record.output_expires_at <= new Date().toISOString(),
	);
	const interactive = record.backend === "pty";
	const perStream = interactive
		? maxBytes
		: Math.max(1, Math.floor(maxBytes / 2));
	const expiredRead = (
		stream: "stdout" | "stderr",
		cursor: number,
		latest: number,
	) => {
		if (cursor > latest) {
			throw new HostSpanError(
				"CURSOR_EXPIRED",
				"Requested process output cursor is beyond the available output.",
				false,
				{
					stream,
					earliest_cursor: latest,
					latest_cursor: latest,
				},
			);
		}
		return {
			text: "",
			next_cursor: latest,
			earliest_cursor: latest,
			bytes_returned: 0,
			dropped_bytes: Math.max(0, latest - cursor),
		};
	};
	const stdout = outputExpired
		? expiredRead("stdout", stdoutCursor, record.stdout_bytes)
		: spool.read("stdout", stdoutCursor, perStream);
	const stderr = interactive
		? {
				text: "",
				next_cursor: stderrCursor,
				earliest_cursor: 0,
				bytes_returned: 0,
				dropped_bytes: 0,
			}
		: outputExpired
			? expiredRead("stderr", stderrCursor, record.stderr_bytes)
			: spool.read("stderr", stderrCursor, perStream);
	const outputBytes = outputExpired ? 0 : spool.retainedBytes;
	const outputBudget =
		record.max_output_bytes !== null && record.max_output_bytes > 0
			? {
					scope: "retained_output" as const,
					limit_bytes: record.max_output_bytes,
					used_bytes: outputBytes,
					remaining_bytes: Math.max(0, record.max_output_bytes - outputBytes),
				}
			: undefined;
	return {
		state: record.state,
		process_id: processId,
		target_id: record.target_id,
		cwd: record.cwd_relative,
		exit_code_scope: "spawned_command",
		output_expired: outputExpired,
		has_more_output:
			stdout.next_cursor < record.stdout_bytes ||
			stderr.next_cursor < record.stderr_bytes,
		stdout: stdout.text,
		stderr: stderr.text,
		next_stdout_cursor: stdout.next_cursor,
		next_stderr_cursor: stderr.next_cursor,
		stdout_dropped_bytes: stdout.dropped_bytes,
		stderr_dropped_bytes: stderr.dropped_bytes,
		stdout_earliest_cursor: stdout.earliest_cursor,
		stderr_earliest_cursor: stderr.earliest_cursor,
		exit_code: record.exit_code,
		signal: record.term_signal,
		reason: record.reason,
		deadline_at: record.deadline_at,
		output_expires_at: record.output_expires_at,
		backend: record.backend,
		interactive,
		...(outputBudget ? { output_budget: outputBudget } : {}),
		...(interactive &&
		!TERMINAL_STATES.has(record.state) &&
		record.backend_ref &&
		terminal
			? {
					terminal_session: record.backend_ref,
					human_attach_command: terminal.humanAttachCommand(
						record.backend_ref,
						false,
					),
					human_attach_read_only_command: terminal.humanAttachCommand(
						record.backend_ref,
						true,
					),
				}
			: {}),
		native_execution: true,
		sandboxed: false,
	};
}
