import type { OperationsRepo } from "../state/operations-repo.js";
import type { ProcessesRepo } from "../state/processes-repo.js";
import type { TmuxTerminalManager } from "./tmux-terminal.js";

export function processGroupAlive(pgid: number | null): boolean {
  if (!pgid || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

export function recoverProcesses(
  processes: ProcessesRepo,
  operations: OperationsRepo,
  terminal?: TmuxTerminalManager,
): Array<{ process_id: string; state: "running" | "succeeded" | "failed" | "timed_out" | "orphaned" | "unknown" }> {
  const recovered: Array<{ process_id: string; state: "running" | "succeeded" | "failed" | "timed_out" | "orphaned" | "unknown" }> = [];
  for (const record of processes.active()) {
    if (record.backend === "tmux") {
      const session = record.backend_ref;
      if (!terminal || !session) {
        processes.markTerminal(record.process_id, "unknown", record.exit_code, record.term_signal, "tmux_recovery_backend_unavailable", record.output_expires_at ?? undefined);
        operations.setState(record.idempotency_key, "unknown", {
          state: "unknown",
          process_id: record.process_id,
          reason: "tmux_recovery_backend_unavailable",
          native_execution: true,
          sandboxed: false,
        });
        recovered.push({ process_id: record.process_id, state: "unknown" });
        continue;
      }
      const state = terminal.inspectSync(session);
      if (!state.exists) {
        processes.markTerminal(record.process_id, "unknown", record.exit_code, record.term_signal, "tmux_session_missing_after_restart", record.output_expires_at ?? undefined);
        operations.setState(record.idempotency_key, "unknown", {
          state: "unknown",
          process_id: record.process_id,
          reason: "tmux_session_missing_after_restart",
          native_execution: true,
          sandboxed: false,
        });
        recovered.push({ process_id: record.process_id, state: "unknown" });
        continue;
      }
      processes.setBytes(record.process_id, "stdout", terminal.outputBytes(record.process_id));
      if (record.deadline_at && record.deadline_at <= new Date().toISOString() && !state.dead) {
        terminal.closeSync(session);
        const drained = terminal.drainOutputSync(session, record.process_id);
        processes.setBytes(record.process_id, "stdout", drained.bytes);
        processes.markTerminal(record.process_id, "timed_out", null, null, "deadline_exceeded_during_restart", record.output_expires_at ?? undefined);
        operations.setState(record.idempotency_key, "timed_out", {
          state: "timed_out",
          process_id: record.process_id,
          reason: "deadline_exceeded_during_restart",
          native_execution: true,
          sandboxed: false,
        });
        recovered.push({ process_id: record.process_id, state: "timed_out" });
        continue;
      }
      if (state.dead) {
        const drained = terminal.drainOutputSync(session, record.process_id);
        processes.setBytes(record.process_id, "stdout", drained.bytes);
        const terminalState = state.exit_code === 0 ? "succeeded" : "failed";
        processes.markTerminal(record.process_id, terminalState, state.exit_code, null, state.exit_code === 0 ? null : "nonzero_exit", record.output_expires_at ?? undefined);
        operations.setState(record.idempotency_key, terminalState, {
          state: terminalState,
          process_id: record.process_id,
          exit_code: state.exit_code,
          native_execution: true,
          sandboxed: false,
        });
        recovered.push({ process_id: record.process_id, state: terminalState });
        continue;
      }
      recovered.push({ process_id: record.process_id, state: "running" });
      continue;
    }
    const alive = processGroupAlive(record.pgid);
    const state = record.state === "running" && alive ? "orphaned" : "unknown";
    const reason = state === "orphaned" ? "daemon_restart_lost_stdio_ownership" : "daemon_restart_crash_boundary";
    processes.markTerminal(record.process_id, state, record.exit_code, record.term_signal, reason, record.output_expires_at ?? undefined);
    operations.setState(record.idempotency_key, state, {
      state,
      process_id: record.process_id,
      reason,
      native_execution: true,
      sandboxed: false,
    });
    recovered.push({ process_id: record.process_id, state });
  }
  return recovered;
}
