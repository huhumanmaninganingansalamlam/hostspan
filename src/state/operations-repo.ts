import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical-json.js";
import type { HostSpanDatabase } from "./database.js";
import { HostSpanError } from "../errors.js";
import { serializeOperationError, type OperationResolution, type OperationsStore } from "../operations/store.js";

function deserializeOperationError(value: unknown): HostSpanError | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stored = value as Record<string, unknown>;
  if (typeof stored.code !== "string" || typeof stored.message !== "string") return undefined;
  return new HostSpanError(
    stored.code as HostSpanError["code"],
    stored.message,
    stored.retryable === true,
    stored.details && typeof stored.details === "object" ? (stored.details as Record<string, unknown>) : {},
  );
}

export function argumentHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export class OperationsRepo implements OperationsStore {
  constructor(private readonly db: HostSpanDatabase) {}

  resolve(idempotencyKey: string, toolName: string, args: unknown, targetId?: string): OperationResolution {
    const hash = argumentHash(args);
    const row = this.db.prepare("SELECT * FROM operations WHERE idempotency_key = ?").get(idempotencyKey) as
      | { argument_hash: string; state: string; result_json: string | null; error_json: string | null }
      | undefined;
    if (row) {
      if (row.argument_hash !== hash) throw new HostSpanError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with different arguments.");
      const result = row.result_json ? JSON.parse(row.result_json) : null;
      if (row.state === "unknown") return { kind: "unknown", state: row.state, result };
      if (["accepted", "launching", "running", "prepared", "committing"].includes(row.state)) return { kind: "join", state: row.state, result };
      const error = row.error_json ? deserializeOperationError(JSON.parse(row.error_json)) : undefined;
      return { kind: "replay", state: row.state, result, ...(error ? { error } : {}) };
    }
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO operations(idempotency_key, tool_name, argument_hash, target_id, state, created_at, updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(idempotencyKey, toolName, hash, targetId ?? null, "accepted", now, now);
    return { kind: "new" };
  }

  setState(idempotencyKey: string, state: string, result?: unknown, error?: unknown): void {
    this.db
      .prepare("UPDATE operations SET state=?, result_json=?, error_json=?, updated_at=? WHERE idempotency_key=?")
      .run(
        state,
        result === undefined ? null : JSON.stringify(result),
        error === undefined ? null : JSON.stringify(serializeOperationError(error)),
        new Date().toISOString(),
        idempotencyKey,
      );
  }

  get(idempotencyKey: string) {
    return this.db.prepare("SELECT * FROM operations WHERE idempotency_key=?").get(idempotencyKey) as Record<string, unknown> | undefined;
  }

  getState(idempotencyKey: string): string | undefined {
    return (this.db.prepare("SELECT state FROM operations WHERE idempotency_key=?").get(idempotencyKey) as { state: string } | undefined)?.state;
  }

  compactResultsOlderThan(days: number, nowMs = Date.now()): number {
    const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
    return this.db
      .prepare(
        `UPDATE operations
         SET result_json=NULL,error_json=NULL
         WHERE updated_at < ?
           AND state NOT IN ('accepted','launching','running','prepared','committing')
           AND (result_json IS NOT NULL OR error_json IS NOT NULL)`,
      )
      .run(cutoff).changes;
  }
}
