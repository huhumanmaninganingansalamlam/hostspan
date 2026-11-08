import type { InteractiveSessionManager } from "./interactive-session.js";
import type { OperationsStore } from "../operations/store.js";
import type { ProcessesStore } from "./store.js";

export function processGroupAlive(pgid: number | null): boolean {
  if (!pgid || pgid <= 0) return false;
  try {
    if (process.platform === "win32") {
      process.kill(pgid, 0);
      return true;
    }
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

export function signalProcessGroup(pgid: number | null, signal: NodeJS.Signals): void {
  if (!pgid || pgid <= 0) return;
  if (process.platform === "win32") {
    // Windows has no general POSIX-style soft signal for an arbitrary process
    // tree. Native HostSpan processes are owned by a dedicated Job Object
    // worker. The caller models grace by waiting before SIGKILL; killing the
    // worker closes the job handle and lets the kernel terminate descendants.
    if (signal !== "SIGKILL") return;
    try {
      process.kill(pgid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return;
  }
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    if (code === "EPERM") {
      // Some Darwin environments can reject a negative-PID process-group
      // signal even though HostSpan still owns the group leader. Fall back to
      // the leader itself, then let the normal group-liveness check decide
      // whether any descendants survived. This never turns an unverifiable
      // process tree into success.
      try {
        process.kill(pgid, signal);
        return;
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code === "ESRCH") return;
        throw fallbackError;
      }
    }
    throw error;
  }
}

export function recoverProcesses(
  processes: ProcessesStore,
  operations: OperationsStore,
  terminal?: InteractiveSessionManager,
  outputTtlMinutes = 60,
  native?: InteractiveSessionManager,
): Array<{ process_id: string; state: "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "orphaned" | "unknown" }> {
  const recovered: Array<{ process_id: string; state: "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "orphaned" | "unknown" }> = [];
  const expiresAt = (existing: string | null): string =>
    existing ?? new Date(Date.now() + outputTtlMinutes * 60_000).toISOString();
  for (const record of processes.active()) {
    if (record.backend === "pty" || record.backend_ref) {
      const manager = record.backend === "pty" ? terminal : native;
      const session = record.backend_ref;
      if (!manager || !session) {
        processes.markTerminal(record.process_id, "unknown", record.exit_code, record.term_signal, `${record.backend}_recovery_backend_unavailable`, expiresAt(record.output_expires_at));
        operations.setState(record.idempotency_key, "unknown", {
          state: "unknown",
          process_id: record.process_id,
          reason: `${record.backend}_recovery_backend_unavailable`,
          native_execution: true,
          sandboxed: false,
        });
        recovered.push({ process_id: record.process_id, state: "unknown" });
        continue;
      }
      const state = manager.inspectSync(session);
      if (!state.exists) {
        processes.markTerminal(record.process_id, "unknown", record.exit_code, record.term_signal, `${record.backend}_session_missing_after_restart`, expiresAt(record.output_expires_at));
        operations.setState(record.idempotency_key, "unknown", {
          state: "unknown",
          process_id: record.process_id,
          reason: `${record.backend}_session_missing_after_restart`,
          native_execution: true,
          sandboxed: false,
        });
        recovered.push({ process_id: record.process_id, state: "unknown" });
        continue;
      }
      if (!state.dead && record.state === "launching" && state.pid !== null) {
        processes.markRunning(record.process_id, state.pid, record.backend === "native" && process.platform !== "win32" ? state.pid : null);
        operations.setState(record.idempotency_key, "running", { state: "running", process_id: record.process_id, backend: record.backend });
      }
      const syncOutput = () => {
        processes.setBytes(record.process_id, "stdout", manager.outputBytes(record.process_id));
        if (record.backend === "native") processes.setBytes(record.process_id, "stderr", manager.outputBytes(record.process_id, "stderr"));
      };
      syncOutput();
      if (record.backend === "pty" && record.deadline_at && record.deadline_at <= new Date().toISOString() && !state.dead) {
        manager.closeSync(session);
        syncOutput();
        const afterClose = manager.inspectSync(session);
        if (afterClose.dead && manager.outputDrained(record.process_id)) {
          processes.markTerminal(
            record.process_id,
            "timed_out",
            afterClose.exit_code,
            afterClose.signal,
            "deadline_exceeded_during_restart",
            expiresAt(record.output_expires_at),
            afterClose.ended_at,
          );
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
        processes.markTerminal(
          record.process_id,
          "unknown",
          null,
          null,
          "deadline_termination_unconfirmed_after_restart",
          expiresAt(record.output_expires_at),
        );
        operations.setState(record.idempotency_key, "unknown", {
          state: "unknown",
          process_id: record.process_id,
          reason: "deadline_termination_unconfirmed_after_restart",
          native_execution: true,
          sandboxed: false,
        });
        recovered.push({ process_id: record.process_id, state: "unknown" });
        continue;
      }
      if (state.dead) {
        syncOutput();
        if (!manager.outputDrained(record.process_id)) {
          processes.markTerminal(
            record.process_id,
            "unknown",
            state.exit_code,
            state.signal,
            `${record.backend}_output_drain_unconfirmed_after_restart`,
            expiresAt(record.output_expires_at),
          );
          operations.setState(record.idempotency_key, "unknown", {
            state: "unknown",
            process_id: record.process_id,
            reason: `${record.backend}_output_drain_unconfirmed_after_restart`,
            native_execution: true,
            sandboxed: false,
          });
          recovered.push({ process_id: record.process_id, state: "unknown" });
          continue;
        }
        const settled = state;
        if (!settled.exists) {
          processes.markTerminal(record.process_id, "unknown", null, null, `${record.backend}_exit_status_unavailable_after_restart`, expiresAt(record.output_expires_at));
          operations.setState(record.idempotency_key, "unknown", {
            state: "unknown",
            process_id: record.process_id,
            reason: `${record.backend}_exit_status_unavailable_after_restart`,
            native_execution: true,
            sandboxed: false,
          });
          recovered.push({ process_id: record.process_id, state: "unknown" });
          continue;
        }
        const terminalState = settled.reason === "deadline_exceeded" ? "timed_out" : settled.reason === "cancel_requested" ? "cancelled" : settled.exit_code === 0 ? "succeeded" : "failed";
        const reason = settled.reason ?? (settled.exit_code === 0 ? null : "nonzero_exit");
        if (settled.reason === "termination_unconfirmed" || (settled.exit_code === null && !settled.reason && !(record.backend === "native" && settled.signal))) {
          processes.markTerminal(record.process_id, "unknown", null, settled.signal, `${record.backend}_exit_status_unavailable_after_restart`, expiresAt(record.output_expires_at));
          operations.setState(record.idempotency_key, "unknown", {
            state: "unknown",
            process_id: record.process_id,
            reason: `${record.backend}_exit_status_unavailable_after_restart`,
            native_execution: true,
            sandboxed: false,
          });
          recovered.push({ process_id: record.process_id, state: "unknown" });
          continue;
        }
        processes.markTerminal(record.process_id, terminalState, settled.exit_code, settled.signal, reason, expiresAt(record.output_expires_at), settled.ended_at);
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
    processes.markTerminal(record.process_id, state, record.exit_code, record.term_signal, reason, expiresAt(record.output_expires_at));
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
