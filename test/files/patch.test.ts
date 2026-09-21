import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import type { HostSpanConfig } from "../../src/config/schema.js";
import {
  cleanupTerminalPatchJournals,
  FilePatchService,
  recoverPatchTransactions,
} from "../../src/files/patch.js";
import type { HostSpanError } from "../../src/mcp/errors.js";
import { PolicyEvaluator } from "../../src/policy/evaluator.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { TransactionsRepo } from "../../src/state/transactions-repo.js";
import { TargetRegistry } from "../../src/targets/registry.js";

const cleanup: string[] = [];

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "hostspan-patch-"));
  cleanup.push(base);
  const root = join(base, "repo");
  const data = join(base, "state");
  mkdirSync(root);
  const config: HostSpanConfig = {
    schema_version: 1,
    policy_epoch: 1,
    server: { listen_host: "127.0.0.1", listen_port: 39393, data_dir: data },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: 16 * 1024 * 1024,
    },
    targets: {
      test: {
        label: "test",
        provider: "local",
        root,
        capabilities: ["read", "write", "git"],
        deny_globs: ["admin.yaml"],
        ignore_globs: [],
      },
    },
    exec_profiles: {},
  };
  const db = openDatabase(join(data, "state.db"));
  const operations = new OperationsRepo(db);
  const transactions = new TransactionsRepo(db);
  const targets = new TargetRegistry(config);
  const target = targets.get("test", "write");
  const policy = new PolicyEvaluator(config);
  const service = new FilePatchService({ data_dir: data, operations, transactions, policy });
  return { base, root, data, config, db, operations, transactions, targets, target, service };
}

afterEach(() => {
  while (cleanup.length) {
    const path = cleanup.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe("hash-guarded patch transaction", () => {
  it("leaves the file unchanged on stale content", () => {
    const { root, target, service, db } = fixture();
    writeFileSync(join(root, "a.txt"), "a\nb\n");
    const before = readFileSync(join(root, "a.txt"), "utf8");
    expect(() =>
      service.apply(target, {
        idempotency_key: uuidv7(),
        target_id: "test",
        dry_run: false,
        files: [{ path: "a.txt", expected_sha256: "0".repeat(64), unified_diff: "@@ -1,2 +1,2 @@\n a\n-b\n+c\n" }],
        validators: [],
      }),
    ).toThrowError(expect.objectContaining<Partial<HostSpanError>>({ code: "STALE_CONTENT" }));
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(before);
    db.close();
  });

  it("leaves the file unchanged on patch or validator failure", () => {
    const { root, target, service, db } = fixture();
    writeFileSync(join(root, "a.txt"), "a\nb\n");
    expect(() =>
      service.apply(target, {
        idempotency_key: uuidv7(),
        target_id: "test",
        dry_run: false,
        files: [{ path: "a.txt", expected_sha256: hash("a\nb\n"), unified_diff: "@@ -1,2 +1,2 @@\n x\n-b\n+c\n" }],
        validators: [],
      }),
    ).toThrowError(expect.objectContaining<Partial<HostSpanError>>({ code: "PATCH_REJECTED" }));
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\nb\n");

    writeFileSync(join(root, "data.json"), "{\"ok\":true}\n");
    expect(() =>
      service.apply(target, {
        idempotency_key: uuidv7(),
        target_id: "test",
        dry_run: false,
        files: [
          {
            path: "data.json",
            expected_sha256: hash("{\"ok\":true}\n"),
            unified_diff: "@@ -1 +1 @@\n-{\"ok\":true}\n+{\"ok\":}\n",
          },
        ],
        validators: ["syntax_check"],
      }),
    ).toThrowError(expect.objectContaining<Partial<HostSpanError>>({ code: "VALIDATION_FAILED" }));
    expect(readFileSync(join(root, "data.json"), "utf8")).toBe("{\"ok\":true}\n");
    db.close();
  });

  it("produces the same staged diff for dry-run and apply and verifies the after hash", () => {
    const { root, data, target, service, transactions, operations, db } = fixture();
    const before = "a\nb\n";
    const patch = "@@ -1,2 +1,2 @@\n a\n-b\n+c\n";
    writeFileSync(join(root, "a.txt"), before);
    const dry = service.apply(target, {
      idempotency_key: uuidv7(),
      target_id: "test",
      dry_run: true,
      files: [{ path: "a.txt", expected_sha256: hash(before), unified_diff: patch }],
      validators: ["git_diff_check"],
    });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(before);
    const key = uuidv7();
    const applied = service.apply(target, {
      idempotency_key: key,
      target_id: "test",
      dry_run: false,
      files: [{ path: "a.txt", expected_sha256: hash(before), unified_diff: patch }],
      validators: ["git_diff_check"],
    });
    expect((dry.files as Array<Record<string, unknown>>)[0]?.unified_diff).toBe((applied.files as Array<Record<string, unknown>>)[0]?.unified_diff);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\nc\n");
    expect((applied.files as Array<Record<string, unknown>>)[0]?.after_sha256).toBe(hash("a\nc\n"));
    expect(existsSync(join(data, "transactions", `${String(applied.transaction_id)}.json`))).toBe(false);
    expect(transactions.get(String(applied.transaction_id))?.state).toBe("verified");
    expect(operations.get(key)?.state).toBe("verified");

    const replay = service.apply(target, {
      idempotency_key: key,
      target_id: "test",
      dry_run: false,
      files: [{ path: "a.txt", expected_sha256: hash(before), unified_diff: patch }],
      validators: ["git_diff_check"],
    });
    expect(replay).toEqual(applied);
    db.close();
  });

  it("applies a valid multi-hunk unified diff", () => {
    const { root, target, service, db } = fixture();
    const before = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const patch = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -6,3 +6,3 @@\n f\n-g\n+G\n h\n";
    writeFileSync(join(root, "a.txt"), before);

    const result = service.apply(target, {
      idempotency_key: uuidv7(),
      target_id: "test",
      dry_run: false,
      files: [{ path: "a.txt", expected_sha256: hash(before), unified_diff: patch }],
      validators: [],
    });

    expect(result).toMatchObject({ state: "verified" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\nB\nc\nd\ne\nf\nG\nh\n");
    db.close();
  });

  it("classifies malformed hunk counts as PATCH_REJECTED without changing the file", () => {
    const { root, target, service, db } = fixture();
    const before = "a\nb\nc\n";
    writeFileSync(join(root, "a.txt"), before);

    expect(() =>
      service.apply(target, {
        idempotency_key: uuidv7(),
        target_id: "test",
        dry_run: false,
        files: [
          {
            path: "a.txt",
            expected_sha256: hash(before),
            unified_diff: "@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n",
          },
        ],
        validators: [],
      }),
    ).toThrowError(expect.objectContaining<Partial<HostSpanError>>({ code: "PATCH_REJECTED" }));
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(before);
    db.close();
  });

  it("rejects reusing an idempotency key with different arguments", () => {
    const { root, target, service, db } = fixture();
    writeFileSync(join(root, "a.txt"), "a\nb\n");
    const key = uuidv7();
    service.apply(target, {
      idempotency_key: key,
      target_id: "test",
      dry_run: true,
      files: [{ path: "a.txt", expected_sha256: hash("a\nb\n"), unified_diff: "@@ -1,2 +1,2 @@\n a\n-b\n+c\n" }],
      validators: [],
    });
    expect(() =>
      service.apply(target, {
        idempotency_key: key,
        target_id: "test",
        dry_run: true,
        files: [{ path: "a.txt", expected_sha256: hash("a\nb\n"), unified_diff: "@@ -1,2 +1,2 @@\n a\n-b\n+d\n" }],
        validators: [],
      }),
    ).toThrowError(expect.objectContaining<Partial<HostSpanError>>({ code: "IDEMPOTENCY_CONFLICT" }));
    db.close();
  });

  it("deterministically rolls back a partially committed journal during startup recovery", () => {
    const { root, data, operations, transactions, targets, db } = fixture();
    const beforeA = "a-old\n";
    const beforeB = "b-old\n";
    const afterA = "a-new\n";
    const afterB = "b-new\n";
    writeFileSync(join(root, "a.txt"), afterA);
    writeFileSync(join(root, "b.txt"), beforeB);
    const key = uuidv7();
    const transactionId = "txn_recoverytest";
    const journalPath = join(data, "transactions", `${transactionId}.json`);
    mkdirSync(join(data, "transactions"), { recursive: true });
    operations.resolve(key, "file_patch", { recovery: true }, "test");
    operations.setState(key, "committing", { transaction_id: transactionId });
    transactions.create(transactionId, key, "test", journalPath);
    db.prepare("UPDATE patch_transactions SET state='committing',updated_at=? WHERE transaction_id=?").run(
      new Date().toISOString(),
      transactionId,
    );
    writeFileSync(
      journalPath,
      JSON.stringify({
        schema_version: 1,
        transaction_id: transactionId,
        idempotency_key: key,
        target_id: "test",
        state: "committing",
        committed_count: 1,
        created_at: new Date().toISOString(),
        files: [
          { path: "a.txt", mode: 0o100644, before_base64: Buffer.from(beforeA).toString("base64"), before_sha256: hash(beforeA), after_sha256: hash(afterA) },
          { path: "b.txt", mode: 0o100644, before_base64: Buffer.from(beforeB).toString("base64"), before_sha256: hash(beforeB), after_sha256: hash(afterB) },
        ],
      }),
    );
    expect(recoverPatchTransactions(targets, transactions)).toEqual([{ transaction_id: transactionId, state: "rolled_back" }]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(beforeA);
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe(beforeB);
    expect(operations.get(key)?.state).toBe("rolled_back");
    expect(existsSync(journalPath)).toBe(false);
    db.close();
  });

  it("cleans a terminal journal left behind after the atomic DB outcome committed", () => {
    const { data, operations, transactions, db } = fixture();
    const key = uuidv7();
    const transactionId = "txn_terminal_journal";
    const journalPath = join(data, "transactions", `${transactionId}.json`);
    mkdirSync(join(data, "transactions"), { recursive: true });
    operations.resolve(key, "file_patch", { cleanup: true }, "test");
    transactions.create(transactionId, key, "test", journalPath);
    transactions.setOutcome(
      transactionId,
      "verified",
      key,
      "verified",
      { state: "verified", transaction_id: transactionId },
    );
    writeFileSync(journalPath, JSON.stringify({ terminal: true }));

    expect(cleanupTerminalPatchJournals(transactions)).toEqual([journalPath]);
    expect(existsSync(journalPath)).toBe(false);
    expect(transactions.get(transactionId)?.state).toBe("verified");
    expect(transactions.get(transactionId)?.journal_path).toBe("");
    expect(operations.get(key)?.state).toBe("verified");
    db.close();
  });
});
