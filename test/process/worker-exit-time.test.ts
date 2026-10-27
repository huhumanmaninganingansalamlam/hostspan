import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalConfigSchema, type HostSpanConfig } from "../../src/config/schema.js";
import { PolicyEvaluator } from "../../src/policy/evaluator.js";
import { PtySessionManager } from "../../src/processes/pty-session.js";
import { recoverProcesses } from "../../src/processes/recovery.js";
import { ProcessSupervisor } from "../../src/processes/supervisor.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";
import { TargetRegistry } from "../../src/targets/registry.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// Reproduce delayed reconciliation of an already-exited worker, without
// dispatching a command or changing a real operation's retained evidence.
it.each(["poll", "restart"])("preserves worker exit time during %s reconciliation", async (path) => {
  const root = mkdtempSync(join(tmpdir(), "hostspan-exit-time-"));
  const db = openDatabase(join(root, "state.db"));
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const processes = new ProcessesRepo(db);
  const operations = new OperationsRepo(db);
  const config: HostSpanConfig = {
    schema_version: 1, policy_epoch: 1,
    server: { listen_host: "127.0.0.1", listen_port: 39393, data_dir: root },
    retention: { completed_process_output_ttl_minutes: 60, operation_result_days: 14, audit_days: 30, max_total_spool_bytes: 1024 * 1024 },
    targets: { test: { label: "Fixture", provider: "local", root, capabilities: ["exec"], exec_profile: "test", deny_globs: [], ignore_globs: [] } },
    exec_profiles: { test: { mode: "native", max_concurrent_processes: 1 } },
  };
  const manager = new PtySessionManager(root, TerminalConfigSchema.parse({}));
  const id = "proc_fixture_exit_time";
  const key = "fixture-exit-key";
  const endedAt = "2026-10-27T18:29:07.745Z";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T18:29:07.731Z"));
  operations.resolve(key, "process_start", { fixture: true }, "test");
  processes.create({ process_id: id, idempotency_key: key, target_id: "test", argv_digest: "fixture", cwd_relative: ".", backend: "pty", backend_ref: id });
  processes.markRunning(id, null, null);
  const dir = join(root, "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ schema_version: 1, process_id: id, session: id, worker_pid: 0, pty_pid: null, status: "exited", exit_code: 137, signal: "SIGKILL", reason: null, columns: 120, rows: 40, output_bytes: 0, ipc_token: "isolated-fixture", ended_at: endedAt }));
  writeFileSync(join(dir, "output-drained"), "");
  vi.setSystemTime(new Date("2026-10-27T18:29:08.231Z"));
  if (path === "restart") {
    recoverProcesses(processes, operations, manager, 60);
  } else {
    const supervisor = new ProcessSupervisor({ config, processes, operations, terminal: manager, targets: new TargetRegistry(config), policy: new PolicyEvaluator(config) });
    await supervisor.poll({ process_id: id, stdout_cursor: 0, stderr_cursor: 0, wait_ms: 0, max_bytes: 100 });
  }
  expect(processes.get(id)).toMatchObject({ ended_at: endedAt, state: "failed", exit_code: 137, term_signal: "SIGKILL", reason: "nonzero_exit", deadline_at: null });
  expect(operations.getState(key)).toBe("failed");
});
