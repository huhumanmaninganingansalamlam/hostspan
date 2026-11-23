import type { ProcessState } from "./store.js";

export const TERMINAL_STATES: ReadonlySet<ProcessState> = new Set<ProcessState>(
	["succeeded", "failed", "timed_out", "cancelled", "orphaned", "unknown"],
);
