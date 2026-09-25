export type ProcessState = "accepted" | "launching" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "orphaned" | "unknown";

export interface ProcessRecord {
  process_id: string;
  idempotency_key: string;
  target_id: string;
  argv_digest: string;
  cwd_relative: string;
  backend: "native" | "pty";
  backend_ref: string | null;
  pid: number | null;
  pgid: number | null;
  deadline_at: string | null;
  max_output_bytes: number | null;
  state: ProcessState;
  exit_code: number | null;
  term_signal: string | null;
  reason: string | null;
  started_at: string | null;
  ended_at: string | null;
  stdout_bytes: number;
  stderr_bytes: number;
  output_expires_at: string | null;
}

export interface ProcessesStore {
  create(
    record: Pick<ProcessRecord, "process_id" | "idempotency_key" | "target_id" | "argv_digest" | "cwd_relative"> &
      Partial<Pick<ProcessRecord, "backend" | "backend_ref" | "deadline_at" | "max_output_bytes">>,
  ): void;
  markRunning(processId: string, pid: number | null, pgid: number | null): boolean;
  markTerminal(processId: string, state: ProcessState, exitCode: number | null, signal: string | null, reason: string | null, expiresAt?: string): void;
  addBytes(processId: string, stream: "stdout" | "stderr", bytes: number): void;
  setBytes(processId: string, stream: "stdout" | "stderr", bytes: number): void;
  get(processId: string): ProcessRecord | undefined;
  getByKey(key: string): ProcessRecord | undefined;
  active(): ProcessRecord[];
  activeInteractive(targetId?: string): ProcessRecord[];
}
