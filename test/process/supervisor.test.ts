import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { ProcessSupervisor } from "../../src/processes/supervisor.js";
import { processGroupAlive } from "../../src/processes/recovery.js";
import { PolicyEvaluator } from "../../src/policy/evaluator.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";
import { TargetRegistry } from "../../src/targets/registry.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
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
      max_total_spool_bytes: 64 * 1024 * 1024,
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
  return { supervisor, processes, db };
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

describe("process supervisor", () => {
  it("returns a terminal result for a short process", async () => {
    const { supervisor, db } = fixture();
    const result = await supervisor.start(startInput(), "req_short");
    expect(result.state).toBe("succeeded");
    expect(result.stdout).toBe("ok");
    expect(result.native_execution).toBe(true);
    expect(result.sandboxed).toBe(false);
    db.close();
  });

  it("returns a process_id quickly for a long silent process and deduplicates retries", async () => {
    const { supervisor, db } = fixture();
    const input = startInput({ argv: ["node", "-e", "setTimeout(()=>{}, 60000)"], wait_ms: 20, deadline_ms: 60_000 });
    const startedAt = Date.now();
    const first = await supervisor.start(input, "req_long_1");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(first.state).toBe("running");
    const second = await supervisor.start(input, "req_long_2");
    expect(second.process_id).toBe(first.process_id);
    expect((await supervisor.cancel({ idempotency_key: uuidv7(), process_id: String(first.process_id), grace_ms: 100 })).state).toBe("cancelled");
    db.close();
  });

  it("preserves UTF-8 characters across process output chunk boundaries", async () => {
    const { supervisor, db } = fixture();
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
    const second = await supervisor.poll({
      process_id: String(started.process_id),
      stdout_cursor: first.stdout === "😀" ? Number(first.next_stdout_cursor) : 0,
      stderr_cursor: 0,
      wait_ms: 500,
      max_bytes: 1024,
    });
    expect(`${first.stdout}${second.stdout}`).toBe("😀");
    db.close();
  });

  it("advances a byte cursor even when max_bytes is smaller than one UTF-8 code point", async () => {
    const { supervisor, db } = fixture();
    const started = await supervisor.start(
      startInput({ argv: ["node", "-e", "process.stdout.write('😀')"], wait_ms: 0 }),
      "req_utf8_tiny_cursor",
    );
    const result = await supervisor.poll({
      process_id: String(started.process_id),
      stdout_cursor: 0,
      stderr_cursor: 0,
      wait_ms: 500,
      max_bytes: 1,
    });
    expect(result.stdout).toBe("😀");
    expect(result.next_stdout_cursor).toBe(4);
    db.close();
  });

  it("kills a process group including descendants on cancel", async () => {
    const { supervisor, processes, db } = fixture();
    const script = "const {spawn}=require('node:child_process');spawn('node',['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});setTimeout(()=>{},60000)";
    const started = await supervisor.start(startInput({ argv: ["node", "-e", script], wait_ms: 30, deadline_ms: 60_000 }), "req_tree");
    const record = processes.get(String(started.process_id));
    expect(record?.pgid).toBeTruthy();
    const cancelled = await supervisor.cancel({ idempotency_key: uuidv7(), process_id: String(started.process_id), grace_ms: 50 });
    expect(cancelled.state).toBe("cancelled");
    expect(processGroupAlive(record?.pgid ?? null)).toBe(false);
    db.close();
  });

  it("enforces hard deadlines and output caps", async () => {
    const { supervisor, db } = fixture();
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
    expect(Buffer.byteLength(String(capped.stdout))).toBeLessThanOrEqual(128);
    db.close();
  });
});
