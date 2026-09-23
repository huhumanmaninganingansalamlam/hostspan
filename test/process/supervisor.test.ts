import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { ProcessSupervisor } from "../../src/processes/supervisor.js";
import { processGroupAlive } from "../../src/processes/recovery.js";
import { cleanupExpiredProcessSpools } from "../../src/processes/output-spool.js";
import { PolicyEvaluator } from "../../src/policy/evaluator.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";
import { TargetRegistry } from "../../src/targets/registry.js";

const roots: string[] = [];
const databases: Array<ReturnType<typeof openDatabase>> = [];
const supervisors: ProcessSupervisor[] = [];

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.shutdown();
  for (const db of databases.splice(0)) {
    try {
      if (db.open) db.close();
    } catch {
      // Test cleanup should not hide the primary assertion failure.
    }
  }
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM" || attempt === 39) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
});

function fixture(maxTotalSpoolBytes = 64 * 1024 * 1024) {
  const root = mkdtempSync(join(tmpdir(), "hostspan-process-"));
  roots.push(root);
  const targetRoot = join(root, "target");
  const dataDir = join(root, "state");
  mkdirSync(targetRoot, { recursive: true });
  const config: HostSpanConfig = {
    schema_version: 1,
    policy_epoch: 1,
    server: { listen_host: "127.0.0.1", listen_port: 39393, data_dir: dataDir },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: maxTotalSpoolBytes,
    },
    targets: {
      test: {
        label: "Test",
        provider: "local",
        root: targetRoot,
        capabilities: ["read", "write", "exec", "git"],
        exec_profile: "native-test",
        deny_globs: [],
        ignore_globs: [],
      },
    },
    exec_profiles: {
      "native-test": {
        mode: "native",
        allowed_programs: ["node"],
        env_allowlist: ["CI"],
        default_deadline_ms: 30_000,
        max_deadline_ms: 60_000,
        default_output_bytes: 1024 * 1024,
        max_output_bytes: 8 * 1024 * 1024,
        max_concurrent_processes: 4,
      },
    },
  };
  const db = openDatabase(join(dataDir, "state.db"));
  databases.push(db);
  const operations = new OperationsRepo(db);
  const processes = new ProcessesRepo(db);
  const targets = new TargetRegistry(config);
  const supervisor = new ProcessSupervisor({
    config,
    targets,
    policy: new PolicyEvaluator(config),
    operations,
    processes,
  });
  supervisors.push(supervisor);
  return { supervisor, processes, db, config };
}

function startInput(overrides: Partial<Parameters<ProcessSupervisor["start"]>[0]> = {}) {
  return {
    idempotency_key: uuidv7(),
    target_id: "test",
    argv: ["node", "-e", "process.stdout.write('ok')"],
    cwd: ".",
    env: {},
    wait_ms: 1_200,
    deadline_ms: 5_000,
    max_output_bytes: 1024 * 1024,
    ...overrides,
  };
}

async function pollUntilTerminal(
  supervisor: ProcessSupervisor,
  processId: string,
  timeoutMs = process.platform === "win32" ? 10_000 : 5_000,
): Promise<Record<string, unknown>> {
  const terminal = new Set(["succeeded", "failed", "timed_out", "cancelled", "orphaned", "unknown"]);
  const deadline = Date.now() + timeoutMs;
  let current: Record<string, unknown> = { state: "running", process_id: processId };
  while (Date.now() < deadline) {
    current = await supervisor.poll({
      process_id: processId,
      stdout_cursor: 0,
      stderr_cursor: 0,
      wait_ms: 500,
      max_bytes: 1024,
    });
    if (terminal.has(String(current.state))) return current;
  }
  throw new Error(`process ${processId} did not reach a terminal state within ${timeoutMs}ms; last=${String(current.state)}`);
}

describe("process supervisor", () => {
  it("returns a terminal result for a short process", async () => {
    const { supervisor } = fixture();
    const result = await supervisor.start(startInput(), "req_short");
    expect(result.state).toBe("succeeded");
    expect(result.stdout).toBe("ok");
    expect(result.output_budget).toEqual({
      scope: "process_lifetime",
      limit_bytes: 1024 * 1024,
      used_bytes: 2,
      remaining_bytes: 1024 * 1024 - 2,
    });
    expect(result.deadline_at).toEqual(expect.any(String));
    expect(result.native_execution).toBe(true);
    expect(result.sandboxed).toBe(false);
  });

  it("releases completed runtime handles instead of retaining every finished process", async () => {
    const { supervisor } = fixture();
    for (let index = 0; index < 12; index += 1) {
      const started = await supervisor.start(startInput({ argv: ["node", "-e", "process.exit(0)"] }), `req_cleanup_${index}`);
      const result =
        started.state === "running"
          ? await pollUntilTerminal(supervisor, String(started.process_id))
          : started;
      expect(result.state).toBe("succeeded");
    }
    const runtimes = (supervisor as unknown as { runtimes: Map<string, unknown> }).runtimes;
    expect(runtimes.size).toBe(0);
  });

  it("evicts oldest completed spool artifacts when retained output exceeds the budget", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-spool-budget-"));
    roots.push(root);
    for (const processId of ["proc_old", "proc_new"]) {
      const spoolDir = join(root, "spools", "processes", processId);
      mkdirSync(spoolDir, { recursive: true });
      writeFileSync(join(spoolDir, "stdout.bin"), "1234567890");
      mkdirSync(join(root, "sessions", processId), { recursive: true });
    }
    const result = cleanupExpiredProcessSpools(root, [], 12, ["proc_old", "proc_new"]);
    expect(result).toMatchObject({ evicted: ["proc_old"], total_bytes: 10, over_quota: false });
    expect(existsSync(join(root, "spools", "processes", "proc_old"))).toBe(false);
    expect(existsSync(join(root, "sessions", "proc_old"))).toBe(false);
    expect(existsSync(join(root, "spools", "processes", "proc_new"))).toBe(true);
  });

  it("rejects new process output when the retained spool budget is already exhausted", async () => {
    const { supervisor, config } = fixture(10);
    const retained = join(config.server.data_dir, "spools", "processes", "proc_retained");
    mkdirSync(retained, { recursive: true });
    writeFileSync(join(retained, "stdout.bin"), "1234567890");
    await expect(supervisor.start(startInput(), "req_spool_full")).rejects.toMatchObject({
      code: "SERVER_BUSY",
      retryable: true,
      details: { resource: "process_output_spool", reason: "capacity_saturated", max_total_spool_bytes: 10 },
    });
  });

  it("replays a pre-spawn capacity rejection for the same idempotency key", async () => {
    const { supervisor, config } = fixture(10);
    const retained = join(config.server.data_dir, "spools", "processes", "proc_retained_retry");
    mkdirSync(retained, { recursive: true });
    writeFileSync(join(retained, "stdout.bin"), "1234567890");
    const input = startInput({ idempotency_key: uuidv7(), max_output_bytes: 8 });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(supervisor.start(input, `req_spool_retry_${attempt}`)).rejects.toMatchObject({
        code: "SERVER_BUSY",
        message: "Process output retention budget cannot satisfy the requested output cap; retry after retained output expires.",
        retryable: true,
        details: { resource: "process_output_spool", reason: "capacity_saturated", requested_output_bytes: 8, remaining_output_bytes: 0 },
      });
    }
  });

  it("reserves the shared spool budget across concurrent process starts", async () => {
    const { supervisor, config } = fixture(10);
    const delayedOutput = "setTimeout(()=>process.stdout.write('12345678'),300);setTimeout(()=>{},60000)";
    const first = await supervisor.start(
      startInput({ argv: ["node", "-e", delayedOutput], wait_ms: 0, deadline_ms: 60_000, max_output_bytes: 8 }),
      "req_spool_reserve_1",
    );
    await expect(
      supervisor.start(
        startInput({ argv: ["node", "-e", delayedOutput], wait_ms: 0, deadline_ms: 60_000, max_output_bytes: 8 }),
        "req_spool_reserve_2",
      ),
    ).rejects.toMatchObject({
      code: "SERVER_BUSY",
      retryable: true,
      details: {
        resource: "process_output_spool",
        reason: "capacity_saturated",
        requested_output_bytes: 8,
        remaining_output_bytes: 2,
        max_total_spool_bytes: 10,
      },
    });
    const root = join(config.server.data_dir, "spools", "processes");
    let total = 0;
    for (const processId of [String(first.process_id)]) {
      const path = join(root, processId, "stdout.bin");
      if (existsSync(path)) total += Buffer.byteLength(String((await import("node:fs")).readFileSync(path)));
    }
    expect(total).toBeLessThanOrEqual(10);
    await supervisor.cancel({ idempotency_key: uuidv7(), process_id: String(first.process_id), grace_ms: 50 });
  });

  it("does not return from cancel while native stdio callbacks can still touch durable state", async () => {
    const { supervisor, db } = fixture();
    const started = await supervisor.start(
      startInput({
        argv: ["node", "-e", "setInterval(()=>process.stdout.write('x'),5)"],
        wait_ms: 0,
        deadline_ms: 60_000,
        max_output_bytes: 64 * 1024,
      }),
      "req_cancel_stdio_settle",
    );
    const cancelled = await supervisor.cancel({
      idempotency_key: uuidv7(),
      process_id: String(started.process_id),
      grace_ms: 50,
    });
    expect(cancelled.state).toBe("cancelled");

    const supervisorIndex = supervisors.indexOf(supervisor);
    if (supervisorIndex >= 0) supervisors.splice(supervisorIndex, 1);
    const dbIndex = databases.indexOf(db);
    if (dbIndex >= 0) databases.splice(dbIndex, 1);
    db.close();

    // If cancel returns before stdout/stderr have settled, a late data event
    // will attempt to read the now-closed database and Vitest will report an
    // unhandled exception during this window.
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  it("returns a process_id quickly for a long silent process and deduplicates retries", async () => {
    const { supervisor } = fixture();
    const input = startInput({ argv: ["node", "-e", "setTimeout(()=>{}, 60000)"], wait_ms: 20, deadline_ms: 60_000 });
    const startedAt = Date.now();
    const first = await supervisor.start(input, "req_long_1");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(first.state).toBe("running");
    const second = await supervisor.start(input, "req_long_2");
    expect(second.process_id).toBe(first.process_id);
    expect((await supervisor.cancel({ idempotency_key: uuidv7(), process_id: String(first.process_id), grace_ms: 100 })).state).toBe("cancelled");
  });

  it("preserves UTF-8 characters across process output chunk boundaries", async () => {
    const { supervisor } = fixture();
    const script = "const b=Buffer.from('😀');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),80)";
    const started = await supervisor.start(startInput({ argv: ["node", "-e", script], wait_ms: 0 }), "req_utf8");
    const first = await supervisor.poll({
      process_id: String(started.process_id),
      stdout_cursor: 0,
      stderr_cursor: 0,
      wait_ms: 20,
      max_bytes: 1024,
    });
    expect(first.stdout === "" || first.stdout === "😀").toBe(true);
    let current = first;
    let text = String(first.stdout ?? "");
    for (let attempt = 0; attempt < 8 && !text.includes("😀"); attempt += 1) {
      current = await supervisor.poll({
        process_id: String(started.process_id),
        stdout_cursor: Number(current.next_stdout_cursor ?? 0),
        stderr_cursor: 0,
        wait_ms: 500,
        max_bytes: 1024,
      });
      text += String(current.stdout ?? "");
    }
    expect(text).toBe("😀");
  });

  it("advances a byte cursor even when max_bytes is smaller than one UTF-8 code point", async () => {
    const { supervisor } = fixture();
    const started = await supervisor.start(
      startInput({ argv: ["node", "-e", "process.stdout.write('😀')"], wait_ms: 0 }),
      "req_utf8_tiny_cursor",
    );
    let cursor = 0;
    let text = "";
    for (let attempt = 0; attempt < 8 && text !== "😀"; attempt += 1) {
      const result = await supervisor.poll({
        process_id: String(started.process_id),
        stdout_cursor: cursor,
        stderr_cursor: 0,
        wait_ms: 500,
        max_bytes: 1,
      });
      const nextCursor = Number(result.next_stdout_cursor ?? cursor);
      expect(nextCursor).toBeGreaterThanOrEqual(cursor);
      if (result.stdout === "") expect(nextCursor).toBe(cursor);
      text += String(result.stdout ?? "");
      cursor = nextCursor;
    }
    expect(text).toBe("😀");
    expect(cursor).toBe(4);
  });

  it("kills a process group including descendants on cancel", async () => {
    const { supervisor, processes } = fixture();
    const script = "const {spawn}=require('node:child_process');spawn('node',['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});setTimeout(()=>{},60000)";
    const started = await supervisor.start(startInput({ argv: ["node", "-e", script], wait_ms: 30, deadline_ms: 60_000 }), "req_tree");
    const record = processes.get(String(started.process_id));
    expect(record?.pgid).toBeTruthy();
    const cancelled = await supervisor.cancel({ idempotency_key: uuidv7(), process_id: String(started.process_id), grace_ms: 50 });
    expect(cancelled.state).toBe("cancelled");
    expect(processGroupAlive(record?.pgid ?? null)).toBe(false);
  });

  it("enforces hard deadlines and output caps", async () => {
    const { supervisor } = fixture();
    const timed = await supervisor.start(
      startInput({ argv: ["node", "-e", "setTimeout(()=>{},60000)"], wait_ms: 400, deadline_ms: 80 }),
      "req_timeout",
    );
    expect(timed.state).toBe("timed_out");

    const capped = await supervisor.start(
      startInput({ argv: ["node", "-e", "process.stdout.write('x'.repeat(10000))"], wait_ms: 1_000, max_output_bytes: 128 }),
      "req_cap",
    );
    expect(capped.state).toBe("failed");
    expect(capped.reason).toBe("output_limit");
    expect(capped.output_budget).toEqual({
      scope: "process_lifetime",
      limit_bytes: 128,
      used_bytes: 128,
      remaining_bytes: 0,
    });
    expect(Buffer.byteLength(String(capped.stdout))).toBeLessThanOrEqual(128);
  });
});
