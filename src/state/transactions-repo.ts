import type { HostSpanDatabase } from "./database.js";
import { HostSpanError } from "../mcp/errors.js";

function serializeTransactionError(error: unknown): unknown {
  if (error instanceof HostSpanError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }
  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message, retryable: false, details: {} };
  }
  return error;
}

export interface PatchTransactionRecord {
  transaction_id: string;
  idempotency_key: string;
  target_id: string;
  journal_path: string;
  state: string;
  created_at: string;
  updated_at: string;
}

export class TransactionsRepo {
  constructor(private readonly db: HostSpanDatabase) {}

  create(transactionId: string, key: string, targetId: string, journalPath: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO patch_transactions(transaction_id,idempotency_key,target_id,journal_path,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(transactionId, key, targetId, journalPath, "prepared", now, now);
  }

  setOutcome(
    transactionId: string,
    transactionState: string,
    idempotencyKey: string,
    operationState: string,
    result?: unknown,
    error?: unknown,
  ): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE patch_transactions SET state=?,updated_at=? WHERE transaction_id=?").run(transactionState, now, transactionId);
      this.db
        .prepare("UPDATE operations SET state=?,result_json=?,error_json=?,updated_at=? WHERE idempotency_key=?")
        .run(
          operationState,
          result === undefined ? null : JSON.stringify(result),
          error === undefined ? null : JSON.stringify(serializeTransactionError(error)),
          now,
          idempotencyKey,
        );
    })();
  }

  get(transactionId: string): PatchTransactionRecord | undefined {
    return this.db.prepare("SELECT * FROM patch_transactions WHERE transaction_id=?").get(transactionId) as PatchTransactionRecord | undefined;
  }

  active(): PatchTransactionRecord[] {
    return this.db.prepare("SELECT * FROM patch_transactions WHERE state IN ('prepared','committing') ORDER BY created_at").all() as PatchTransactionRecord[];
  }

  terminalJournals(): Array<{ transaction_id: string; journal_path: string }> {
    return this.db
      .prepare(
        "SELECT transaction_id,journal_path FROM patch_transactions WHERE state NOT IN ('prepared','committing') ORDER BY updated_at",
      )
      .all() as Array<{ transaction_id: string; journal_path: string }>;
  }

  clearJournalPath(transactionId: string): void {
    this.db.prepare("UPDATE patch_transactions SET journal_path='' WHERE transaction_id=?").run(transactionId);
  }

  pruneTerminalOlderThan(days: number, nowMs = Date.now()): number {
    const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
    return this.db
      .prepare(
        `DELETE FROM patch_transactions
         WHERE state NOT IN ('prepared','committing')
           AND updated_at < ?
           AND journal_path=''
           AND EXISTS (
             SELECT 1 FROM operations o
             WHERE o.idempotency_key=patch_transactions.idempotency_key
               AND o.result_json IS NULL
               AND o.error_json IS NULL
           )`,
      )
      .run(cutoff).changes;
  }
}
