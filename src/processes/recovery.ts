import type { OperationsRepo } from "../state/operations-repo.js";
import type { ProcessesRepo } from "../state/processes-repo.js";

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
): Array<{ process_id: string; state: "orphaned" | "unknown" }> {
  const recovered: Array<{ process_id: string; state: "orphaned" | "unknown" }> = [];
  for (const record of processes.active()) {
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
