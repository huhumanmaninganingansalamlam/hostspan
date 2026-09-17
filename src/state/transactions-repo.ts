import type { HostSpanDatabase } from "./database.js";

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

  setState(transactionId: string, state: string): void {
    this.db.prepare("UPDATE patch_transactions SET state=?,updated_at=? WHERE transaction_id=?").run(state, new Date().toISOString(), transactionId);
  }

  get(transactionId: string): PatchTransactionRecord | undefined {
    return this.db.prepare("SELECT * FROM patch_transactions WHERE transaction_id=?").get(transactionId) as PatchTransactionRecord | undefined;
  }

  active(): PatchTransactionRecord[] {
    return this.db.prepare("SELECT * FROM patch_transactions WHERE state IN ('prepared','committing') ORDER BY created_at").all() as PatchTransactionRecord[];
  }
}
