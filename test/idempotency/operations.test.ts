import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { HostSpanError } from "../../src/mcp/errors.js";
import { openDatabase } from "../../src/state/database.js";
import { argumentHash, OperationsRepo } from "../../src/state/operations-repo.js";

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
});
