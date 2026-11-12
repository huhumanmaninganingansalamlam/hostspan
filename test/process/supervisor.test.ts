import fs, { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { HostSpanError } from "../../src/errors.js";
import { HostSpanConfigSchema, TerminalConfigSchema, type HostSpanConfig } from "../../src/config/schema.js";
import { createInitialConfig } from "../../src/config/defaults.js";
import { createRuntime } from "../../src/runtime/create-runtime.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import type { InteractiveSessionManager } from "../../src/processes/interactive-session.js";
import { ProcessSupervisor } from "../../src/processes/supervisor.js";
import { PtySessionManager } from "../../src/processes/pty-session.js";
import { processGroupAlive } from "../../src/processes/recovery.js";
import { OutputSpool, cleanupExpiredProcessSpools } from "../../src/processes/output-spool.js";
import { PolicyEvaluator } from "../../src/policy/evaluator.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";
import { TargetRegistry } from "../../src/targets/registry.js";

const roots: string[] = [];
const databases: Array<ReturnType<typeof openDatabase>> = [];
const supervisors: ProcessSupervisor[] = [];
const nativeSessions: Array<{ manager: PtySessionManager; session: string }> = [];

afterEach(async () => {
  for (const { manager, session } of nativeSessions.splice(0)) manager.closeSync(session);
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

function fixture(maxTotalSpoolBytes = 64 * 1024 * 1024, terminal?: InteractiveSessionManager, completedOutputTtlMinutes = 60) {
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
      completed_process_output_ttl_minutes: completedOutputTtlMinutes,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: maxTotalSpoolBytes,
    },
    targets: {
      test: {
        label: "Test",
        provider: "local",
        root: targetRoot,
        capabilities: ["read", "write", "exec", ...(terminal ? ["terminal" as const] : [])],
        exec_profile: "native-test",
        deny_globs: [],
        ignore_globs: [],
      },
    },
    exec_profiles: {
      "native-test": {
        mode: "native",
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
    ...(terminal ? { terminal } : {}),
  });
  supervisors.push(supervisor);
  return { supervisor, processes, operations, db, config, targetRoot };
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

// Startup is not the latency under test. Wait for actual bytes under the existing
// process deadline before measuring how quickly a poll returns unread output.
async function waitForNativeOutput(supervisor: ProcessSupervisor, processes: ProcessesRepo, processId: string, stream: "stdout" | "stderr") {
  while ((processes.get(processId)?.[`${stream}_bytes`] ?? 0) === 0) {
    const result = await supervisor.poll({ process_id: processId, stdout_cursor: 0, stderr_cursor: 0, max_bytes: 1024, wait_ms: 100 });
    expect(result.state).toBe("running");
  }
}

describe("process supervisor", () => {
  it("defaults new and omitted process output retention to 24 hours while honoring an explicit 60 minutes", () => {
    const initial = createInitialConfig();
    expect(initial.retention).toMatchObject({
      completed_process_output_ttl_minutes: 1_440,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: 1_073_741_824,
    });
    const omittedRetention: Partial<HostSpanConfig["retention"]> = { ...initial.retention };
    delete omittedRetention.completed_process_output_ttl_minutes;
    const omitted = HostSpanConfigSchema.parse({ ...initial, retention: omittedRetention });
    expect(omitted.retention.completed_process_output_ttl_minutes).toBe(1_440);
    const explicit = HostSpanConfigSchema.parse({
      ...initial,
      retention: { ...omittedRetention, completed_process_output_ttl_minutes: 60 },
    });
    expect(explicit.retention.completed_process_output_ttl_minutes).toBe(60);
  });

  it("retains completed output up to 24 hours and reports expiry without losing process metadata", async () => {
    const { supervisor, processes } = fixture(64 * 1024 * 1024, undefined, 1_440);
    const earliestFinishMs = Date.now();
    const started = await supervisor.start(startInput({ wait_ms: 0 }), "req_output_ttl_24h");
    const id = String(started.process_id);
    const completed = await pollUntilTerminal(supervisor, id);
    expect(completed).toMatchObject({ state: "succeeded", stdout: "ok", output_expired: false });

    const expiry = Date.parse(String(processes.get(id)?.output_expires_at));
    const expectedTtlMs = 1_440 * 60_000;
    expect(expiry).toBeGreaterThanOrEqual(earliestFinishMs + expectedTtlMs);
    expect(expiry).toBeLessThanOrEqual(Date.now() + expectedTtlMs);

    const input = { process_id: id, stdout_cursor: 0, stderr_cursor: 0, max_bytes: 1024, wait_ms: 0 };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(expiry - 1));
      expect(await supervisor.poll(input)).toMatchObject({ state: "succeeded", stdout: "ok", output_expired: false });
      vi.setSystemTime(new Date(expiry));
      expect(await supervisor.poll(input)).toMatchObject({
        state: "succeeded",
        exit_code: 0,
        stdout: "",
        output_expired: true,
        stdout_dropped_bytes: 2,
        stdout_earliest_cursor: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an unconfirmed native worker launch recoverable without replaying it", async () => {
    const { config, processes, operations } = fixture();
    const targets = new TargetRegistry(config);
    const native = {
      sessionName: (id: string) => id,
      start: vi.fn(async () => { throw new HostSpanError("PROCESS_UNKNOWN", "worker startup wait elapsed"); }),
      inspect: async () => ({ exists: false }),
      outputBytes: () => 0,
    } as unknown as InteractiveSessionManager;
    const supervisor = new ProcessSupervisor({ config, targets, processes, operations, policy: new PolicyEvaluator(config), native });
    const input = startInput();
    await expect(supervisor.start(input, "req_native_uncertain")).rejects.toMatchObject({ code: "PROCESS_UNKNOWN", details: { process_id: expect.any(String) } });
    expect(processes.getByKey(input.idempotency_key)).toMatchObject({ state: "launching", backend: "native", backend_ref: expect.any(String), output_expires_at: null });
    expect(await supervisor.start(input, "req_native_uncertain_replay")).toMatchObject({ state: "launching" });
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(operations.getState(input.idempotency_key)).toBe("unknown");
  });

  it("preserves native stdout/stderr and final exit across daemon replacement without terminal capability", async () => {
    const { config, targetRoot } = fixture();
    const configPath = join(config.server.data_dir, "config.yaml");
    writeConfigAtomic(configPath, config);
    let runtime = createRuntime(configPath);
    const manager = new PtySessionManager(config.server.data_dir, TerminalConfigSchema.parse({}), { backend: "native" });
    const stale = new PtySessionManager(config.server.data_dir, TerminalConfigSchema.parse({}), { backend: "native", requireOwnership: true });
    const generation = manager.currentOwnerGeneration();
    if (generation === null) throw new Error("native ownership was not activated");
    stale.activateOwnership(generation);
    const { deadline_ms: _deadline, ...input } = startInput({
      argv: [process.execPath, "-e", "const fs=require('node:fs');fs.appendFileSync('starts','1');process.stdout.write('before-out\\n');process.stderr.write('before-err\\n');const t=setInterval(()=>{if(fs.existsSync('finish')){clearInterval(t);process.stdout.write('after-out\\n');process.stderr.write('after-err\\n');process.exitCode=7}},20)"],
      wait_ms: 0,
    });
    try {
      const started = await runtime.supervisor.start(input, "req_native_durable");
      const id = String(started.process_id);
      nativeSessions.push({ manager, session: id });
      expect(started).toMatchObject({ backend: "native", interactive: false });
      expect(started).not.toHaveProperty("terminal_session");
      expect(runtime.processes.get(id)?.backend_ref).toBe(id);
      await expect.poll(() => manager.outputBytes(id)).toBeGreaterThan(0);
      await runtime.supervisor.shutdown();
      await runtime.close();
      expect(manager.inspectSync(id)).toMatchObject({ exists: true, dead: false });

      runtime = createRuntime(configPath);
      expect(runtime.processes.get(id)?.state).toBe("running");
      await expect(stale.close(id)).rejects.toMatchObject({ code: "SERVER_BUSY", details: { reason: "stale_runtime_owner" } });
      await expect(runtime.supervisor.write({ process_id: id, idempotency_key: uuidv7(), chars: "x", control_keys: [], stdout_cursor: 0, wait_ms: 0, max_bytes: 100 })).rejects.toMatchObject({ code: "TERMINAL_NOT_INTERACTIVE" });
      const replay = await runtime.supervisor.start(input, "req_native_replay");
      expect(replay.process_id).toBe(id);
      expect(readFileSync(join(targetRoot, "starts"), "utf8")).toBe("1");
      await runtime.supervisor.shutdown();
      await runtime.close();
      writeFileSync(join(targetRoot, "finish"), "finish");
      await expect(manager.waitForExitStatus(id, 5_000)).resolves.toMatchObject({ exists: true, dead: true, exit_code: 7 });
      runtime = createRuntime(configPath);
      const result = await pollUntilTerminal(runtime.supervisor, id);
      expect(result).toMatchObject({ state: "failed", exit_code: 7, stdout: "before-out\nafter-out\n", stderr: "before-err\nafter-err\n" });
    } finally {
      await runtime.close();
    }
  });

  it("enforces the original native deadline while the daemon is absent and recovers the final output", async () => {
    const { config } = fixture();
    const configPath = join(config.server.data_dir, "config.yaml");
    writeConfigAtomic(configPath, config);
    let runtime = createRuntime(configPath);
    const manager = new PtySessionManager(config.server.data_dir, TerminalConfigSchema.parse({}), { backend: "native" });
    try {
      const started = await runtime.supervisor.start(startInput({ argv: [process.execPath, "-e", "process.stdout.write('deadline-out');process.stderr.write('deadline-err');setInterval(()=>{},1000)"], deadline_ms: 10_000, wait_ms: 0 }), "req_native_deadline");
      const id = String(started.process_id);
      nativeSessions.push({ manager, session: id });
      await expect.poll(() => manager.outputBytes(id) > 0 && manager.outputBytes(id, "stderr") > 0, { timeout: 8_000 }).toBe(true);
      await runtime.supervisor.shutdown();
      await runtime.close();
      await expect(manager.waitForExitStatus(id, 15_000)).resolves.toMatchObject({ exists: true, dead: true, reason: "deadline_exceeded" });
      runtime = createRuntime(configPath);
      expect(await runtime.supervisor.poll({ process_id: id, stdout_cursor: 0, stderr_cursor: 0, wait_ms: 0, max_bytes: 1024 })).toMatchObject({ state: "timed_out", stdout: "deadline-out", stderr: "deadline-err", deadline_at: started.deadline_at });
    } finally {
      await runtime.close();
    }
  });

  it("cancels a durable native process through the recovered worker", async () => {
    const { config } = fixture();
    const configPath = join(config.server.data_dir, "config.yaml");
    writeConfigAtomic(configPath, config);
    let runtime = createRuntime(configPath);
    const manager = new PtySessionManager(config.server.data_dir, TerminalConfigSchema.parse({}), { backend: "native" });
    try {
      const descendant = "process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid));setInterval(()=>{},1000)";
      const script = `process.on('SIGTERM',()=>{});require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
      const started = await runtime.supervisor.start(startInput({ argv: [process.execPath, "-e", script], wait_ms: 0 }), "req_native_cancel");
      const id = String(started.process_id);
      nativeSessions.push({ manager, session: id });
      await expect.poll(() => manager.outputBytes(id), { timeout: 10_000 }).toBeGreaterThan(0);
      await runtime.supervisor.shutdown();
      await runtime.close();
      runtime = createRuntime(configPath);
      expect(manager.outputBytes(id)).toBeGreaterThan(0);
      const before = await runtime.supervisor.poll({ process_id: id, stdout_cursor: 0, stderr_cursor: 0, wait_ms: 0, max_bytes: 1024 });
      const descendantPid = Number(before.stdout);
      expect(descendantPid).toBeGreaterThan(0);
      const input = { process_id: id, idempotency_key: uuidv7(), grace_ms: 100 };
      expect(await runtime.supervisor.cancel(input)).toMatchObject({ state: "cancelled", process_id: id });
      expect(await runtime.supervisor.cancel(input)).toMatchObject({ state: "cancelled", process_id: id });
      expect(manager.inspectSync(id)).toMatchObject({ exists: true, dead: true });
      await expect.poll(() => { try { process.kill(descendantPid, 0); return true; } catch { return false; } }).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("replays a proven pre-dispatch write failure without delivering input", async () => {
    const failure = new Error("output unavailable before dispatch");
    const terminal = { outputBytes: vi.fn(() => { throw failure; }), write: vi.fn() } as unknown as InteractiveSessionManager;
    const { supervisor, processes, operations } = fixture(undefined, terminal);
    processes.create({ process_id: "preflight", idempotency_key: uuidv7(), target_id: "test", argv_digest: "sha256:test", cwd_relative: ".", backend: "pty", backend_ref: "session" });
    processes.markRunning("preflight", null, null);
    const input = { process_id: "preflight", idempotency_key: uuidv7(), chars: "once", control_keys: [], stdout_cursor: 0, max_bytes: 1024, wait_ms: 0 };
    await expect(supervisor.write(input)).rejects.toThrow(failure.message);
    expect(operations.resolve(input.idempotency_key, "process_write", input, "test")).toMatchObject({ kind: "replay", state: "failed", result: { input_delivered: false } });
    await expect(supervisor.write(input)).rejects.toThrow(failure.message);
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it("retains confirmed cancellation when final output observation fails", async () => {
    const terminal = {
      close: vi.fn(async () => {}),
      waitForExitStatus: vi.fn(async () => ({ exists: true, dead: true, exit_code: 0, signal: null })),
      waitForOutputDrain: vi.fn(async () => { throw new Error("output unavailable after termination"); }),
      humanAttachCommand: () => "attach",
    } as unknown as InteractiveSessionManager;
    const { supervisor, processes, operations } = fixture(undefined, terminal);
    processes.create({ process_id: "cancelled", idempotency_key: uuidv7(), target_id: "test", argv_digest: "sha256:test", cwd_relative: ".", backend: "pty", backend_ref: "session" });
    processes.markRunning("cancelled", null, null);
    const input = { process_id: "cancelled", idempotency_key: uuidv7(), grace_ms: 0 };
    await expect(supervisor.cancel(input)).rejects.toThrow("output unavailable after termination");
    expect(processes.get("cancelled")?.state).toBe("cancelled");
    expect(operations.getState(input.idempotency_key)).toBe("succeeded");
    await expect(supervisor.cancel(input)).resolves.toMatchObject({ state: "cancelled", process_id: "cancelled" });
    expect(terminal.close).toHaveBeenCalledTimes(1);
  });

  it("does not resend cancellation with an unconfirmed outcome", async () => {
    const terminal = { close: vi.fn(async () => { throw new Error("termination ACK lost"); }) } as unknown as InteractiveSessionManager;
    const { supervisor, processes, operations } = fixture(undefined, terminal);
    processes.create({ process_id: "uncertain", idempotency_key: uuidv7(), target_id: "test", argv_digest: "sha256:test", cwd_relative: ".", backend: "pty", backend_ref: "session" });
    processes.markRunning("uncertain", null, null);
    const input = { process_id: "uncertain", idempotency_key: uuidv7(), grace_ms: 0 };
    await expect(supervisor.cancel(input)).rejects.toThrow("termination ACK lost");
    expect(operations.getState(input.idempotency_key)).toBe("unknown");
    await expect(supervisor.cancel(input)).resolves.toMatchObject({ state: "unknown" });
    expect(terminal.close).toHaveBeenCalledTimes(1);
  });

  it.each(["stdout", "stderr"] as const)("returns unread native %s immediately", async (stream) => {
    const { supervisor, processes } = fixture();
    const started = await supervisor.start(startInput({ argv: ["node", "-e", `setTimeout(()=>process.${stream}.write('ready'),1100);setInterval(()=>{},1000)`], wait_ms: 0 }), "req_ready_output");
    const processId = String(started.process_id);
    await waitForNativeOutput(supervisor, processes, processId, stream);
    expect(processes.get(processId)?.[`${stream}_bytes`]).toBe(5);
    const before = Date.now();
    const result = await supervisor.poll({ process_id: processId, stdout_cursor: 0, stderr_cursor: 0, max_bytes: 1024, wait_ms: 2_000 });
    expect(result[stream]).toBe("ready");
    expect(Date.now() - before).toBeLessThan(1_000);
  });

  it("waits when native output contains only an incomplete UTF-8 character", async () => {
    const { supervisor, processes } = fixture();
    const started = await supervisor.start(startInput({ argv: ["node", "-e", "process.stdout.write(Buffer.from([0xe2]));setInterval(()=>{},1000)"], wait_ms: 0 }), "req_partial_output");
    const processId = String(started.process_id);
    await waitForNativeOutput(supervisor, processes, processId, "stdout");
    expect(processes.get(processId)?.stdout_bytes).toBe(1);
    const before = Date.now();
    const result = await supervisor.poll({ process_id: processId, stdout_cursor: 0, stderr_cursor: 0, max_bytes: 1024, wait_ms: 150 });
    expect(result.next_stdout_cursor).toBe(0);
    expect(Date.now() - before).toBeGreaterThanOrEqual(125);
  });

  it("recovers native crash-boundary records after activation with PTY disabled", async () => {
    const { config, processes, db } = fixture();
    const configPath = join(config.server.data_dir, "config.yaml");
    writeConfigAtomic(configPath, config);
    const key = uuidv7();
    const input = { target_id: "test", idempotency_key: key, argv: ["node"] };
    new OperationsRepo(db).resolve(key, "process_start", input, "test");
    processes.create({ process_id: "proc_crashed", idempotency_key: key, target_id: "test", argv_digest: "sha256:test", cwd_relative: "." });
    const runtime = createRuntime(configPath, { deferActivation: true });
    try {
      expect(runtime.processes.get("proc_crashed")?.state).toBe("launching");
      runtime.activate();
      expect(runtime.processes.get("proc_crashed")?.state).toBe("unknown");
      expect(runtime.processes.activeCount()).toBe(0);
      expect(runtime.operations.resolve(key, "process_start", input, "test").kind).toBe("unknown");
    } finally {
      await runtime.close();
    }
  });

  it("returns a terminal result for a short process", async () => {
    const { supervisor } = fixture();
    const started = await supervisor.start(startInput(), "req_short");
    const result = started.state === "running" ? await pollUntilTerminal(supervisor, String(started.process_id)) : started;
    expect(result.state).toBe("succeeded");
    expect(result.stdout).toBe("ok");
    expect(result.output_budget).toEqual({
      scope: "retained_output",
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

  it("preserves output and cursors when an append publishes during a read", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-spool-read-"));
    roots.push(root);
    const writer = new OutputSpool(root, "concurrent-read", 128);
    writer.append("stdout", Buffer.alloc(4096, 120));
    writer.append("stdout", Buffer.from("INFO:RECOVERY_READY\r\n"));
    const cursor = writer.highWater("stdout");
    writer.append("stdout", Buffer.from("resume"));
    const reader = new OutputSpool(root, "concurrent-read", 128);
    const echo = reader.read("stdout", cursor, 32);
    const original = fs.readFileSync;
    let appended = false;
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const result = Reflect.apply(original, fs, args);
      if (!appended && String(args[0]).endsWith("index.json")) {
        appended = true;
        writer.append("stdout", Buffer.from("RECOVERED\r\n"));
      }
      return result;
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    let during: ReturnType<OutputSpool["read"]>;
    try {
      during = reader.read("stdout", echo.next_cursor, 32);
    } finally {
      fs.readFileSync = original;
      syncBuiltinESMExports();
    }
    const after = reader.read("stdout", during.next_cursor, 32);
    expect(echo.text + during.text + after.text).toBe("resumeRECOVERED\r\n");
    expect(during.dropped_bytes + after.dropped_bytes).toBe(0);
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

  it("enforces explicit deadlines but only caps capture for verbose work", async () => {
    const { supervisor, targetRoot } = fixture();
    const timed = await supervisor.start(
      startInput({ argv: ["node", "-e", "setTimeout(()=>{},60000)"], wait_ms: 400, deadline_ms: 80 }),
      "req_timeout",
    );
    expect(timed.state).toBe("timed_out");

    const capped = await supervisor.start(
      startInput({
        argv: ["node", "-e", "process.stdout.write('0123456789abcdef'.repeat(625),()=>setTimeout(()=>require('node:fs').writeFileSync('done','ok'),100))"],
        deadline_ms: undefined,
        wait_ms: 1_000,
        max_output_bytes: 128,
        max_bytes: 16,
      }),
      "req_cap",
    );
    expect(capped.state).toBe("succeeded");
    expect(capped.deadline_at).toBeNull();
    expect(readFileSync(join(targetRoot, "done"), "utf8")).toBe("ok");
    expect(capped.output_budget).toEqual({
      scope: "retained_output",
      limit_bytes: 128,
      used_bytes: 128,
      remaining_bytes: 0,
    });
    expect(capped.stdout).toBe("01234567");
    expect(capped.stdout_dropped_bytes).toBe(9_872);
    expect(capped.stdout_earliest_cursor).toBe(9_872);
  });
});
