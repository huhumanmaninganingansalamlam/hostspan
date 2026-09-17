import { createHash } from "node:crypto";
import type { HostSpanDatabase } from "./database.js";
import { HostSpanError } from "../mcp/errors.js";

export type OperationResolution =
  | { kind: "new" }
  | { kind: "replay"; state: string; result: unknown }
  | { kind: "join"; state: string; result: unknown }
  | { kind: "unknown"; state: string; result: unknown };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function argumentHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export class OperationsRepo {
  constructor(private readonly db: HostSpanDatabase) {}

  resolve(idempotencyKey: string, toolName: string, args: unknown, targetId?: string): OperationResolution {
    const hash = argumentHash(args);
    const row = this.db.prepare("SELECT * FROM operations WHERE idempotency_key = ?").get(idempotencyKey) as
      | { argument_hash: string; state: string; result_json: string | null }
      | undefined;
    if (row) {
      if (row.argument_hash !== hash) throw new HostSpanError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with different arguments.");
      const result = row.result_json ? JSON.parse(row.result_json) : null;
      if (row.state === "unknown") return { kind: "unknown", state: row.state, result };
      if (["accepted", "launching", "running", "prepared", "committing"].includes(row.state)) return { kind: "join", state: row.state, result };
      return { kind: "replay", state: row.state, result };
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
        error === undefined ? null : JSON.stringify(error),
        new Date().toISOString(),
        idempotencyKey,
      );
  }

  get(idempotencyKey: string) {
    return this.db.prepare("SELECT * FROM operations WHERE idempotency_key=?").get(idempotencyKey) as Record<string, unknown> | undefined;
  }
}
