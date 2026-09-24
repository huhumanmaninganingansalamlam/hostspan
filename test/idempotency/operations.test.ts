import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { HostSpanError } from "../../src/errors.js";
import { HostSpanError as HostSpanErrorValue } from "../../src/errors.js";
import { openDatabase } from "../../src/state/database.js";
import { argumentHash, OperationsRepo } from "../../src/state/operations-repo.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";
import { TransactionsRepo } from "../../src/state/transactions-repo.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hostspan-idempotency-"));
  roots.push(root);
  const db = openDatabase(join(root, "state.db"));
  return { db, operations: new OperationsRepo(db) };
}

describe("durable operation idempotency", () => {
  it("uses a canonical argument hash independent of object key order", () => {
    expect(argumentHash({ a: 1, b: { x: true, y: [1, 2] } })).toBe(
      argumentHash({ b: { y: [1, 2], x: true }, a: 1 }),
    );
  });

  it("joins active work and replays terminal results for the same arguments", () => {
    const { db, operations } = fixture();
    const key = uuidv7();
    const args = { target_id: "local", value: 1 };
    expect(operations.resolve(key, "file_patch", args, "local")).toEqual({ kind: "new" });
    operations.setState(key, "running", { process_id: "proc_one" });
    expect(operations.resolve(key, "file_patch", args, "local")).toMatchObject({
      kind: "join",
      state: "running",
      result: { process_id: "proc_one" },
    });
    operations.setState(key, "succeeded", { state: "succeeded", marker: 1 });
    expect(operations.resolve(key, "file_patch", args, "local")).toMatchObject({
      kind: "replay",
      state: "succeeded",
      result: { state: "succeeded", marker: 1 },
    });
    db.close();
  });

  it("rejects key reuse with different arguments", () => {
    const { db, operations } = fixture();
    const key = uuidv7();
    operations.resolve(key, "process_start", { target_id: "local", argv: ["node", "a.js"] }, "local");
    expect(() =>
      operations.resolve(key, "process_start", { target_id: "local", argv: ["node", "b.js"] }, "local"),
    ).toThrowError(expect.objectContaining<Partial<HostSpanError>>({ code: "IDEMPOTENCY_CONFLICT" }));
    db.close();
  });

  it("keeps UNKNOWN sticky instead of creating a second side effect", () => {
    const { db, operations } = fixture();
    const key = uuidv7();
    const args = { target_id: "local", argv: ["node", "a.js"] };
    operations.resolve(key, "process_start", args, "local");
    operations.setState(key, "unknown", { state: "unknown", reason: "crash_boundary" });
    expect(operations.resolve(key, "process_start", args, "local")).toMatchObject({
      kind: "unknown",
      state: "unknown",
      result: { state: "unknown", reason: "crash_boundary" },
    });
    db.close();
  });

  it("persists a terminal HostSpan error so an identical retry can replay the rejection", () => {
    const { db, operations } = fixture();
    const key = uuidv7();
    const args = { target_id: "local", argv: ["node", "a.js"] };
    operations.resolve(key, "process_start", args, "local");
    operations.setState(
      key,
      "failed",
      undefined,
      new HostSpanErrorValue("SERVER_BUSY", "capacity is exhausted", true, { resource: "process_output_spool" }),
    );
    const replay = operations.resolve(key, "process_start", args, "local");
    expect(replay).toMatchObject({
      kind: "replay",
      state: "failed",
      error: {
        code: "SERVER_BUSY",
        message: "capacity is exhausted",
        retryable: true,
        details: { resource: "process_output_spool" },
      },
    });
    db.close();
  });

  it("compacts old terminal payloads while preserving the idempotency tombstone", () => {
    const { db, operations } = fixture();
    const key = uuidv7();
    const args = { target_id: "local", value: 1 };
    operations.resolve(key, "file_patch", args, "local");
    operations.setState(key, "verified", { state: "verified", large: "x".repeat(4096) });
    db.prepare("UPDATE operations SET updated_at=? WHERE idempotency_key=?").run(
      new Date(Date.now() - 15 * 86_400_000).toISOString(),
      key,
    );

    expect(operations.compactResultsOlderThan(14)).toBe(1);
    expect(operations.resolve(key, "file_patch", args, "local")).toMatchObject({
      kind: "replay",
      state: "verified",
      result: null,
    });
    expect(() => operations.resolve(key, "file_patch", { ...args, value: 2 }, "local")).toThrowError(
      expect.objectContaining<Partial<HostSpanError>>({ code: "IDEMPOTENCY_CONFLICT" }),
    );
    db.close();
  });

  it("prunes old process and patch detail rows only after operation payload compaction", () => {
    const { db, operations } = fixture();
    const processes = new ProcessesRepo(db);
    const transactions = new TransactionsRepo(db);
    const old = new Date(Date.now() - 15 * 86_400_000).toISOString();

    const processKey = uuidv7();
    const processArgs = { target_id: "local", argv: ["node", "-e", "0"] };
    operations.resolve(processKey, "process_start", processArgs, "local");
    processes.create({
      process_id: "proc_retention",
      idempotency_key: processKey,
      target_id: "local",
      argv_digest: "sha256:test",
      cwd_relative: ".",
      max_output_bytes: 4096,
    });
    processes.markTerminal("proc_retention", "succeeded", 0, null, null, old);
    operations.setState(processKey, "succeeded", { state: "succeeded", process_id: "proc_retention" });
    db.prepare("UPDATE processes SET ended_at=?,output_expires_at=? WHERE process_id=?").run(
      old,
      old,
      "proc_retention",
    );
    db.prepare("UPDATE operations SET updated_at=? WHERE idempotency_key=?").run(old, processKey);

    const patchKey = uuidv7();
    operations.resolve(patchKey, "file_patch", { target_id: "local", marker: 1 }, "local");
    transactions.create("txn_retention", patchKey, "local", join(tmpdir(), "txn-retention.json"));
    transactions.setOutcome(
      "txn_retention",
      "verified",
      patchKey,
      "verified",
      { state: "verified", transaction_id: "txn_retention" },
    );
    db.prepare("UPDATE patch_transactions SET updated_at=? WHERE transaction_id=?").run(old, "txn_retention");
    db.prepare("UPDATE operations SET updated_at=? WHERE idempotency_key=?").run(old, patchKey);

    expect(processes.pruneTerminalMetadataOlderThan(14)).toBe(0);
    expect(transactions.pruneTerminalOlderThan(14)).toBe(0);
    expect(operations.compactResultsOlderThan(14)).toBe(2);
    expect(processes.pruneTerminalMetadataOlderThan(14)).toBe(1);
    expect(transactions.pruneTerminalOlderThan(14)).toBe(0);
    transactions.clearJournalPath("txn_retention");
    expect(transactions.pruneTerminalOlderThan(14)).toBe(1);
    expect(processes.get("proc_retention")).toBeUndefined();
    expect(transactions.get("txn_retention")).toBeUndefined();
    expect(operations.resolve(processKey, "process_start", processArgs, "local")).toMatchObject({
      kind: "replay",
      state: "succeeded",
      result: null,
    });
    expect(operations.get(patchKey)).toMatchObject({ state: "verified", result_json: null, error_json: null });
    db.close();
  });
});
