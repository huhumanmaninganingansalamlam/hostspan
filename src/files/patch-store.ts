export interface PatchTransactionRecord {
  transaction_id: string;
  idempotency_key: string;
  target_id: string;
  journal_path: string;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface PatchTransactionStore {
  create(transactionId: string, key: string, targetId: string, journalPath: string): void;
  setOutcome(
    transactionId: string,
    transactionState: string,
    idempotencyKey: string,
    operationState: string,
    result?: unknown,
    error?: unknown,
  ): void;
  active(): PatchTransactionRecord[];
  terminalJournals(): Array<{ transaction_id: string; journal_path: string }>;
  clearJournalPath(transactionId: string): void;
}
