import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { processGroupAlive, recoverProcesses, signalProcessGroup } from "../../src/processes/recovery.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hostspan-recovery-"));
  roots.push(root);
  const db = openDatabase(join(root, "state.db"));
  return { db, operations: new OperationsRepo(db), processes: new ProcessesRepo(db) };
}

describe("process recovery", () => {
  it("marks a launching crash boundary UNKNOWN without replaying it", () => {
    const { db, operations, processes } = fixture();
    const key = uuidv7();
    const args = { idempotency_key: key, target_id: "t", argv: ["node"], cwd: "." };
    expect(operations.resolve(key, "process_start", args, "t").kind).toBe("new");
    processes.create({ process_id: "proc_launching", idempotency_key: key, target_id: "t", argv_digest: "sha256:x", cwd_relative: "." });
    operations.setState(key, "launching", { process_id: "proc_launching" });
    expect(recoverProcesses(processes, operations)).toEqual([{ process_id: "proc_launching", state: "unknown" }]);
    expect(processes.get("proc_launching")?.state).toBe("unknown");
    expect(operations.resolve(key, "process_start", args, "t").kind).toBe("unknown");
    db.close();
  });

  it("marks a still-live process orphaned instead of claiming success", async () => {
    const { db, operations, processes } = fixture();
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { detached: true, stdio: "ignore" });
    const pid = child.pid;
    if (!pid) throw new Error("child has no pid");
    const key = uuidv7();
    const args = { idempotency_key: key, target_id: "t", argv: ["node"], cwd: "." };
    operations.resolve(key, "process_start", args, "t");
    processes.create({ process_id: "proc_running", idempotency_key: key, target_id: "t", argv_digest: "sha256:y", cwd_relative: "." });
    processes.markRunning("proc_running", pid, pid);
    operations.setState(key, "running", { process_id: "proc_running" });
    expect(recoverProcesses(processes, operations)).toEqual([{ process_id: "proc_running", state: "orphaned" }]);
    expect(processes.get("proc_running")?.state).toBe("orphaned");
    expect(processGroupAlive(pid)).toBe(true);
    signalProcessGroup(pid, "SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(processGroupAlive(pid)).toBe(false);
    db.close();
  });
});
