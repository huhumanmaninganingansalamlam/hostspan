import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { processGroupAlive, recoverProcesses, signalProcessGroup } from "../../src/processes/recovery.js";
import type { InteractiveSessionManager, InteractiveSessionSnapshot } from "../../src/processes/interactive-session.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hostspan-recovery-"));
  roots.push(root);
  const db = openDatabase(join(root, "state.db"));
  return { db, operations: new OperationsRepo(db), processes: new ProcessesRepo(db) };
}

function terminalFixture(snapshot: InteractiveSessionSnapshot, options: { drained?: boolean; onClose?: () => void } = {}): InteractiveSessionManager {
  return {
    backend: "pty",
    sessionName: (processId) => processId,
    humanAttachCommand: (session) => `attach ${session}`,
    available: async () => true,
    start: async () => ({ session: "unused", pid: null }),
    inspect: async () => snapshot,
    inspectSync: () => snapshot,
    write: async () => undefined,
    close: async () => undefined,
    closeSync: () => options.onClose?.(),
    outputBytes: () => 0,
    outputDrained: () => options.drained ?? false,
    waitForOutputDrain: async () => ({ drained: options.drained ?? false, bytes: 0 }),
    waitForExitStatus: async () => snapshot,
    waitForActivity: async () => snapshot,
    attach: async () => undefined,
  };
}

describe("process recovery", () => {
  it.runIf(process.platform !== "win32")("falls back to the group leader when a POSIX group signal is denied", () => {
    const calls: Array<{ pid: number; signal: string | number }> = [];
    vi.spyOn(process, "kill").mockImplementation((pid, signal = 0) => {
      calls.push({ pid, signal });
      if (pid < 0) {
        const error = new Error("group signal denied") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return true;
    });

    expect(() => signalProcessGroup(4242, "SIGTERM")).not.toThrow();
    expect(calls).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: 4242, signal: "SIGTERM" },
    ]);
  });

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

  it("uses unknown when an expired PTY cannot prove termination during restart recovery", () => {
    const { db, operations, processes } = fixture();
    const key = uuidv7();
    const args = { idempotency_key: key, target_id: "t", argv: ["node"], cwd: ".", tty: true };
    operations.resolve(key, "process_start", args, "t");
    processes.create({
      process_id: "proc_expired_pty",
      idempotency_key: key,
      target_id: "t",
      argv_digest: "sha256:pty",
      cwd_relative: ".",
      backend: "pty",
      backend_ref: "proc_expired_pty",
      deadline_at: new Date(Date.now() - 1000).toISOString(),
      max_output_bytes: 1024,
    });
    processes.markRunning("proc_expired_pty", 1234, null);
    operations.setState(key, "running", { process_id: "proc_expired_pty" });
    let closeCalls = 0;
    const running: InteractiveSessionSnapshot = {
      exists: true,
      dead: false,
      exit_code: null,
      signal: null,
      reason: null,
      pid: 1234,
      columns: 80,
      rows: 24,
    };
    const terminal = terminalFixture(running, { onClose: () => closeCalls++ });

    expect(recoverProcesses(processes, operations, terminal)).toEqual([{ process_id: "proc_expired_pty", state: "unknown" }]);
    expect(closeCalls).toBe(1);
    expect(processes.get("proc_expired_pty")).toMatchObject({
      state: "unknown",
      reason: "deadline_termination_unconfirmed_after_restart",
    });
    expect(processes.get("proc_expired_pty")?.output_expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    db.close();
  });

  it("does not claim a successful PTY exit before output drain is durable", () => {
    const { db, operations, processes } = fixture();
    const key = uuidv7();
    const args = { idempotency_key: key, target_id: "t", argv: ["node"], cwd: ".", tty: true };
    operations.resolve(key, "process_start", args, "t");
    processes.create({
      process_id: "proc_undrained_pty",
      idempotency_key: key,
      target_id: "t",
      argv_digest: "sha256:pty",
      cwd_relative: ".",
      backend: "pty",
      backend_ref: "proc_undrained_pty",
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      max_output_bytes: 1024,
    });
    processes.markRunning("proc_undrained_pty", 1234, null);
    operations.setState(key, "running", { process_id: "proc_undrained_pty" });
    const dead: InteractiveSessionSnapshot = {
      exists: true,
      dead: true,
      exit_code: 0,
      signal: null,
      reason: null,
      pid: 1234,
      columns: 80,
      rows: 24,
    };

    expect(recoverProcesses(processes, operations, terminalFixture(dead))).toEqual([
      { process_id: "proc_undrained_pty", state: "unknown" },
    ]);
    expect(processes.get("proc_undrained_pty")).toMatchObject({
      state: "unknown",
      reason: "pty_output_drain_unconfirmed_after_restart",
    });
    expect(processes.get("proc_undrained_pty")?.output_expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    db.close();
  });
});
