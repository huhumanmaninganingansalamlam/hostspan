import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { HostSpanConfig } from "../../src/config/schema.js";
import type { ProcessWriteToolInput } from "../../src/mcp/schemas.js";
import { PolicyEvaluator } from "../../src/policy/evaluator.js";
import { recoverProcesses } from "../../src/processes/recovery.js";
import { ProcessSupervisor } from "../../src/processes/supervisor.js";
import { TmuxTerminalManager } from "../../src/processes/tmux-terminal.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";
import { TargetRegistry } from "../../src/targets/registry.js";

const roots: string[] = [];
const tmuxManagers: TmuxTerminalManager[] = [];

afterEach(() => {
  for (const terminal of tmuxManagers.splice(0)) {
    // Each test uses an isolated tmux socket; killing the server cannot affect user sessions.
    try {
      spawnSync("tmux", ["-S", terminal.socketPath, "kill-server"], { stdio: "ignore" });
    } catch {
      // Best-effort isolated test cleanup.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(terminalCapability = true) {
  const root = mkdtempSync(join(tmpdir(), "hostspan-tmux-"));
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
    terminal: {
      backend: "tmux",
      max_concurrent_sessions: 2,
      history_limit_lines: 10_000,
      max_output_bytes: 1024 * 1024,
    },
    targets: {
      test: {
        label: "Test",
        provider: "local",
        root: targetRoot,
        capabilities: terminalCapability ? ["read", "exec", "terminal"] : ["read", "exec"],
        exec_profile: "native-test",
        deny_globs: [],
        ignore_globs: [],
      },
    },
    exec_profiles: {
      "native-test": {
        mode: "native",
        allowed_programs: ["node"],
        env_allowlist: [],
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
  const terminalConfig = config.terminal;
  if (!terminalConfig) throw new Error("terminal fixture configuration is missing");
  const terminal = new TmuxTerminalManager(dataDir, terminalConfig);
  tmuxManagers.push(terminal);
  const supervisor = new ProcessSupervisor({
    config,
    targets,
    policy: new PolicyEvaluator(config),
    operations,
    processes,
    terminal,
  });
  return { config, db, operations, processes, targets, terminal, supervisor };
}

function ttyInput(script: string) {
  return {
    idempotency_key: uuidv7(),
    target_id: "test",
    argv: ["node", "-e", script],
    cwd: ".",
    env: {},
    wait_ms: 300,
    deadline_ms: 10_000,
    max_output_bytes: 1024 * 1024,
    tty: true,
    columns: 100,
    rows: 30,
  };
}

describe("tmux interactive process backend", () => {
  it("supports interactive input, control-friendly polling, resize, and human attach commands", async () => {
    const { supervisor, db } = fixture();
    const script = [
      "const readline=require('node:readline');",
      "const rl=readline.createInterface({input:process.stdin,output:process.stdout});",
      "console.log('READY');",
      "rl.question('NAME? ',name=>{console.log('HELLO '+name);rl.close();});",
    ].join("");
    const started = await supervisor.start(ttyInput(script), "req_tmux_start");
    expect(started.interactive).toBe(true);
    expect(started.backend).toBe("tmux");
    expect(String(started.human_attach_command)).toContain("tmux -S");
    expect(String(started.human_attach_read_only_command)).toContain("attach-session -r");

    const cursor = Number(started.next_stdout_cursor ?? 0);
    const writeInput: ProcessWriteToolInput = {
      idempotency_key: uuidv7(),
      process_id: String(started.process_id),
      chars: "world",
      control_keys: ["Enter"],
      columns: 132,
      rows: 42,
      stdout_cursor: cursor,
      wait_ms: 1_000,
      max_bytes: 64 * 1024,
    };
    const [written, joined] = await Promise.all([supervisor.write(writeInput), supervisor.write(writeInput)]);
    expect(String(written.stdout)).toContain("HELLO world");
    expect(joined).toEqual(written);
    await expect(supervisor.write(writeInput)).resolves.toEqual(written);
    await expect(supervisor.write({ ...writeInput, chars: "duplicate" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const terminal =
      written.state === "running"
        ? await supervisor.poll({
            process_id: String(started.process_id),
            stdout_cursor: Number(written.next_stdout_cursor ?? 0),
            stderr_cursor: 0,
            wait_ms: 500,
            max_bytes: 64 * 1024,
          })
        : written;
    expect(terminal.state).toBe("succeeded");
    db.close();
  });

  it("keeps a running tmux process recoverable across HostSpan runtime restart", async () => {
    const first = fixture();
    const started = await first.supervisor.start(
      ttyInput("console.log('LIVE');setTimeout(()=>{},60000)"),
      "req_tmux_persist_start",
    );
    expect(started.state).toBe("running");
    const processId = String(started.process_id);
    const session = String(started.terminal_session);
    first.db.close();

    const db = openDatabase(join(first.config.server.data_dir, "state.db"));
    const operations = new OperationsRepo(db);
    const processes = new ProcessesRepo(db);
    const recovered = recoverProcesses(processes, operations, first.terminal);
    expect(recovered).toContainEqual({ process_id: processId, state: "running" });
    expect(first.terminal.inspectSync(session)).toMatchObject({ exists: true, dead: false });

    const supervisor = new ProcessSupervisor({
      config: first.config,
      targets: first.targets,
      policy: new PolicyEvaluator(first.config),
      operations,
      processes,
      terminal: first.terminal,
    });
    const polled = await supervisor.poll({ process_id: processId, stdout_cursor: 0, stderr_cursor: 0, wait_ms: 0, max_bytes: 64 * 1024 });
    expect(polled.state).toBe("running");
    const cancelled = await supervisor.cancel({ idempotency_key: uuidv7(), process_id: processId, grace_ms: 200 });
    expect(cancelled.state).toBe("cancelled");
    expect(first.terminal.inspectSync(session).exists).toBe(false);
    db.close();
  });

  it("requires an explicit terminal capability even when exec is allowed", async () => {
    const { supervisor, db } = fixture(false);
    await expect(supervisor.start(ttyInput("setTimeout(()=>{},1000)"), "req_tmux_denied")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    db.close();
  });
});
