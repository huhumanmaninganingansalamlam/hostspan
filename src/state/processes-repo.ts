import type { HostSpanDatabase } from "./database.js";

export type ProcessState = "accepted" | "launching" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "orphaned" | "unknown";

export interface ProcessRecord {
  process_id: string;
  idempotency_key: string;
  target_id: string;
  argv_digest: string;
  cwd_relative: string;
  backend: "native" | "pty" | "tmux";
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

export class ProcessesRepo {
  constructor(private readonly db: HostSpanDatabase) {}

  create(
    record: Pick<ProcessRecord, "process_id" | "idempotency_key" | "target_id" | "argv_digest" | "cwd_relative"> &
      Partial<Pick<ProcessRecord, "backend" | "backend_ref" | "deadline_at" | "max_output_bytes">>,
  ): void {
    this.db
      .prepare(
        "INSERT INTO processes(process_id,idempotency_key,target_id,argv_digest,cwd_relative,backend,backend_ref,deadline_at,max_output_bytes,state) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        record.process_id,
        record.idempotency_key,
        record.target_id,
        record.argv_digest,
        record.cwd_relative,
        record.backend ?? "native",
        record.backend_ref ?? null,
        record.deadline_at ?? null,
        record.max_output_bytes ?? null,
        "launching",
      );
  }

  markRunning(processId: string, pid: number | null, pgid: number | null): void {
    this.db.prepare("UPDATE processes SET state='running', pid=?, pgid=?, started_at=? WHERE process_id=?").run(pid, pgid, new Date().toISOString(), processId);
  }

  markTerminal(processId: string, state: ProcessState, exitCode: number | null, signal: string | null, reason: string | null, expiresAt?: string): void {
    this.db
      .prepare("UPDATE processes SET state=?,exit_code=?,term_signal=?,reason=?,ended_at=?,output_expires_at=? WHERE process_id=?")
      .run(state, exitCode, signal, reason, new Date().toISOString(), expiresAt ?? null, processId);
  }

  setState(processId: string, state: ProcessState, reason?: string): void {
    this.db.prepare("UPDATE processes SET state=?, reason=? WHERE process_id=?").run(state, reason ?? null, processId);
  }

  addBytes(processId: string, stream: "stdout" | "stderr", bytes: number): void {
    const column = stream === "stdout" ? "stdout_bytes" : "stderr_bytes";
    this.db.prepare(`UPDATE processes SET ${column}=${column}+? WHERE process_id=?`).run(bytes, processId);
  }

  setBytes(processId: string, stream: "stdout" | "stderr", bytes: number): void {
    const column = stream === "stdout" ? "stdout_bytes" : "stderr_bytes";
    this.db.prepare(`UPDATE processes SET ${column}=? WHERE process_id=?`).run(bytes, processId);
  }

  get(processId: string): ProcessRecord | undefined {
    return this.db.prepare("SELECT * FROM processes WHERE process_id=?").get(processId) as ProcessRecord | undefined;
  }

  getByKey(key: string): ProcessRecord | undefined {
    return this.db.prepare("SELECT * FROM processes WHERE idempotency_key=?").get(key) as ProcessRecord | undefined;
  }

  active(): ProcessRecord[] {
    return this.db.prepare("SELECT * FROM processes WHERE state IN ('accepted','launching','running')").all() as ProcessRecord[];
  }

  activeCount(): number {
    return (this.db.prepare("SELECT count(*) AS count FROM processes WHERE state IN ('accepted','launching','running')").get() as { count: number }).count;
  }

  activeCountForTarget(targetId: string): number {
    return (
      this.db
        .prepare("SELECT count(*) AS count FROM processes WHERE target_id=? AND state IN ('accepted','launching','running')")
        .get(targetId) as { count: number }
    ).count;
  }

  activeCountForTargetBackend(targetId: string, backend: ProcessRecord["backend"]): number {
    return (
      this.db
        .prepare("SELECT count(*) AS count FROM processes WHERE target_id=? AND backend=? AND state IN ('accepted','launching','running')")
        .get(targetId, backend) as { count: number }
    ).count;
  }

  expiredOutput(nowIso = new Date().toISOString()): ProcessRecord[] {
    return this.db
      .prepare("SELECT * FROM processes WHERE output_expires_at IS NOT NULL AND output_expires_at <= ?")
      .all(nowIso) as ProcessRecord[];
  }

  recent(limit = 200): ProcessRecord[] {
    return this.db.prepare("SELECT * FROM processes ORDER BY COALESCE(started_at, ended_at) DESC LIMIT ?").all(limit) as ProcessRecord[];
  }
}
