import type { OperationsRepo } from "../state/operations-repo.js";
import type { ProcessesRepo } from "../state/processes-repo.js";
import type { InteractiveSessionManager } from "./interactive-session.js";

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
  terminal?: InteractiveSessionManager,
): Array<{ process_id: string; state: "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "orphaned" | "unknown" }> {
  const recovered: Array<{ process_id: string; state: "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "orphaned" | "unknown" }> = [];
  for (const record of processes.active()) {
    if (record.backend === "tmux") {
      processes.markTerminal(record.process_id, "unknown", record.exit_code, record.term_signal, "legacy_tmux_backend_unsupported", record.output_expires_at ?? undefined);
      operations.setState(record.idempotency_key, "unknown", {
        state: "unknown",
        process_id: record.process_id,
        reason: "legacy_tmux_backend_unsupported",
        native_execution: true,
        sandboxed: false,
      });
      recovered.push({ process_id: record.process_id, state: "unknown" });
      continue;
    }
    if (record.backend === "pty") {
      const session = record.backend_ref;
      if (!terminal || !session) {
        processes.markTerminal(record.process_id, "unknown", record.exit_code, record.term_signal, "pty_recovery_backend_unavailable", record.output_expires_at ?? undefined);
        operations.setState(record.idempotency_key, "unknown", {
          state: "unknown",
          process_id: record.process_id,
          reason: "pty_recovery_backend_unavailable",
          native_execution: true,
          sandboxed: false,
        });
        recovered.push({ process_id: record.process_id, state: "unknown" });
        continue;
      }
      const state = terminal.inspectSync(session);
      if (!state.exists) {
        processes.markTerminal(record.process_id, "unknown", record.exit_code, record.term_signal, "pty_session_missing_after_restart", record.output_expires_at ?? undefined);
        operations.setState(record.idempotency_key, "unknown", {
          state: "unknown",
          process_id: record.process_id,
          reason: "pty_session_missing_after_restart",
          native_execution: true,
          sandboxed: false,
        });
        recovered.push({ process_id: record.process_id, state: "unknown" });
        continue;
      }
      processes.setBytes(record.process_id, "stdout", terminal.outputBytes(record.process_id));
      if (record.deadline_at && record.deadline_at <= new Date().toISOString() && !state.dead) {
        terminal.closeSync(session);
        const drained = { bytes: terminal.outputBytes(record.process_id) };
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
        processes.setBytes(record.process_id, "stdout", terminal.outputBytes(record.process_id));
        const settled = state;
        if (!settled.exists) {
          processes.markTerminal(record.process_id, "unknown", null, null, "pty_exit_status_unavailable_after_restart", record.output_expires_at ?? undefined);
          operations.setState(record.idempotency_key, "unknown", {
            state: "unknown",
            process_id: record.process_id,
            reason: "pty_exit_status_unavailable_after_restart",
            native_execution: true,
            sandboxed: false,
          });
          recovered.push({ process_id: record.process_id, state: "unknown" });
          continue;
        }
        const terminalState = settled.reason === "deadline_exceeded" ? "timed_out" : settled.reason === "cancel_requested" ? "cancelled" : settled.exit_code === 0 ? "succeeded" : "failed";
        const reason = settled.reason ?? (settled.exit_code === 0 ? null : "nonzero_exit");
        if (settled.exit_code === null && !settled.reason) {
          processes.markTerminal(record.process_id, "unknown", null, settled.signal, "pty_exit_status_unavailable_after_restart", record.output_expires_at ?? undefined);
          operations.setState(record.idempotency_key, "unknown", {
            state: "unknown",
            process_id: record.process_id,
            reason: "pty_exit_status_unavailable_after_restart",
            native_execution: true,
            sandboxed: false,
          });
          recovered.push({ process_id: record.process_id, state: "unknown" });
          continue;
        }
        processes.markTerminal(record.process_id, terminalState, settled.exit_code, settled.signal, reason, record.output_expires_at ?? undefined);
        operations.setState(record.idempotency_key, terminalState, {
          state: terminalState,
          process_id: record.process_id,
          exit_code: settled.exit_code,
          signal: settled.signal,
          reason,
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
