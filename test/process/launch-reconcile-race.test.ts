import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { HostSpanConfigSchema } from "../../src/config/schema.js";
import { PolicyEvaluator } from "../../src/policy/evaluator.js";
import type { InteractiveSessionManager, StartInteractiveSessionInput } from "../../src/processes/interactive-session.js";
import { ProcessSupervisor } from "../../src/processes/supervisor.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";
import { TargetRegistry } from "../../src/targets/registry.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

it.each(["reconciled", "cancelled", "failed"] as const)("handles %s state reached before launch returns", async (state) => {
  const root = mkdtempSync(join(tmpdir(), "hostspan-launch-race-"));
  const db = openDatabase(join(root, "state.db"));
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const config = HostSpanConfigSchema.parse({
    schema_version: 1, policy_epoch: 1,
    server: { data_dir: root },
    terminal: {}, retention: {}, exec_profiles: {},
    targets: { test: { label: "Fixture", root, provider: "local", capabilities: ["terminal"] } },
  });
  const processes = new ProcessesRepo(db);
  const operations = new OperationsRepo(db);
  const live = { exists: true, dead: false, pid: 4242, exit_code: null, signal: null, reason: null, columns: 120, rows: 40 };
  let supervisor: ProcessSupervisor;
  const manager = {
    backend: "pty",
    sessionName: (id: string) => id,
    start: vi.fn(async ({ processId }: StartInteractiveSessionInput) => {
      // Deliberately run the actual reconciliation while start is suspended.
      if (state === "reconciled") await supervisor.reconcileInteractiveProcesses("test");
      else {
        const record = processes.get(processId);
        if (!record) throw new Error("missing fixture process");
        processes.markTerminal(processId, state, null, null, `fixture_${state}`);
        operations.setState(record.idempotency_key, state);
      }
      return { session: processId, pid: live.pid };
    }),
    inspect: async () => live,
    outputBytes: () => 0,
    waitForActivity: vi.fn(async () => live),
    closeSync: vi.fn(),
    humanAttachCommand: () => "fixture-only",
  } as unknown as InteractiveSessionManager;
  const waitForActivity = vi.mocked(manager.waitForActivity);
  const closeSync = vi.mocked(manager.closeSync);
  supervisor = new ProcessSupervisor({ config, processes, operations, terminal: manager, targets: new TargetRegistry(config), policy: new PolicyEvaluator(config) });
  const input = { idempotency_key: uuidv7(), target_id: "test", argv: ["fixture-only"], cwd: ".", env: {}, tty: true, wait_ms: 1000, max_output_bytes: 1024 };
  const result = await supervisor.start(input, "req_fixture_launch_race");
  const id = String(result.process_id);
  if (state === "reconciled") {
    expect(processes.get(id)).toMatchObject({ state: "running", pid: live.pid, backend_ref: id });
    expect(result.state).toBe("running");
    expect(closeSync).not.toHaveBeenCalled();
    expect(waitForActivity).toHaveBeenCalledWith(id, id, 0, 1000);
  } else {
    expect(result.state).toBe(state);
    expect(processes.get(id)?.reason).toBe(`fixture_${state}`);
    expect(closeSync).toHaveBeenCalledExactlyOnceWith(id);
    expect(waitForActivity).not.toHaveBeenCalled();
  }
  expect(operations.getState(input.idempotency_key)).toBe(state === "reconciled" ? "running" : state);
  expect(manager.start).toHaveBeenCalledTimes(1);
});
