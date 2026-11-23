import { HostSpanError } from "../errors.js";

export type DesktopPermission = "screen_recording" | "accessibility";
export type DesktopActivity = "viewing" | "controlling";
export type DesktopSessionPhase =
	| "closed"
	| "connecting"
	| "awaiting_consent"
	| "ready"
	| "processing"
	| "unavailable"
	| "failed";

export interface DesktopSessionState {
	backend: "native" | "wayland-portal";
	sessionId: string | undefined;
	sessionCreatedAt: string | undefined;
	observationId: string | undefined;
	workerPid: number | undefined;
	permission: DesktopPermission | undefined;
	openError: Error | undefined;
	captureError: Error | undefined;
	opening: boolean;
	hasPending: boolean;
	observing: boolean;
	activity: DesktopActivity | undefined;
}

export interface DesktopStatus {
	state: DesktopSessionPhase;
	message: string;
	next_action: {
		tool: "computer";
		arguments: { action: "open" | "observe"; session_id?: string };
	};
	[key: string]: unknown;
}

export function buildDesktopStatus(
	state: DesktopSessionState,
	desktopTarget: Record<string, unknown>,
): DesktopStatus {
	if (!state.sessionId)
		return {
			state: state.openError ? "failed" : "closed",
			message: state.openError
				? `Desktop connection failed: ${state.openError.message}`
				: "Desktop control is closed.",
			...(state.openError instanceof HostSpanError
				? { error_details: state.openError.details }
				: {}),
			next_action: { tool: "computer", arguments: { action: "open" } },
		};
	return {
		...desktopTarget,
		session_id: state.sessionId,
		session_created_at: state.sessionCreatedAt,
		worker_pid: state.workerPid,
		lifetime: "explicit_close_or_os_end_or_worker_exit",
		state: state.opening
			? state.backend === "native" && !state.permission
				? "connecting"
				: "awaiting_consent"
			: state.hasPending || state.observing
				? "processing"
				: state.captureError
					? "unavailable"
					: "ready",
		...(state.permission ? { required_os_permission: state.permission } : {}),
		...(state.activity ? { activity: state.activity } : {}),
		message: state.opening
			? state.permission
				? `Allow HostSpan in macOS ${state.permission === "screen_recording" ? "Screen Recording" : "Accessibility"} settings. Close computer to cancel waiting.`
				: state.backend === "native"
					? "Connecting to this computer's logged-in desktop."
					: "Select a screen and allow control in the desktop sharing dialog. You can close to cancel."
			: state.activity === "viewing"
				? "HostSpan is viewing this screen."
				: state.activity === "controlling"
					? "HostSpan is controlling this screen."
					: state.hasPending || state.observing
						? "A desktop action is processing. Wait before sending another input."
						: state.captureError
							? `Desktop capture unavailable: ${state.captureError.message}`
							: "Desktop connected. Observe the screen before choosing where to act.",
		frame_ready:
			!!state.observationId && !state.captureError && !state.observing,
		...(state.captureError instanceof HostSpanError
			? { error_details: state.captureError.details }
			: {}),
		next_action: {
			tool: "computer",
			arguments: { action: "observe", session_id: state.sessionId },
		},
		...(state.opening || state.hasPending || state.observing
			? { retry_after_ms: 1000 }
			: {}),
	};
}
