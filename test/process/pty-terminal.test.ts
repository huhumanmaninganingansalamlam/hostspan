import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { main } from "../../src/cli/index.js";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import type { ProcessWriteToolInput } from "../../src/mcp/schemas.js";
import { PolicyEvaluator } from "../../src/policy/evaluator.js";
import { PtySessionManager } from "../../src/processes/pty-session.js";
import { ptySocketPath } from "../../src/processes/pty-ipc.js";
import { recoverProcesses } from "../../src/processes/recovery.js";
import { ProcessSupervisor } from "../../src/processes/supervisor.js";
import { claimRuntimeGeneration, openDatabase, runtimeGeneration } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";
import { TargetRegistry } from "../../src/targets/registry.js";

const roots: string[] = [];
const sessions: Array<{ terminal: PtySessionManager; session: string }> = [];
const attachments: Socket[] = [];
const databases: Array<ReturnType<typeof openDatabase>> = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const socket of attachments.splice(0)) socket.destroy();
  for (const entry of sessions.splice(0)) entry.terminal.closeSync(entry.session);
  for (const db of databases.splice(0)) {
    try {
      if (db.open) db.close();
    } catch {
      // Test cleanup should not hide the primary assertion failure.
    }
  }
  await sleep(100);
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM" || attempt === 39) throw error;
        await sleep(25);
      }
    }
  }
});

function fixture(terminalCapability = true, maxConcurrentSessions = 2, requireOwnership = false, listenPort = 39393) {
  const root = mkdtempSync(join(tmpdir(), "hostspan-pty-"));
  roots.push(root);
  const targetRoot = join(root, "target");
  const dataDir = join(root, "state");
  mkdirSync(targetRoot, { recursive: true });
  const config: HostSpanConfig = {
    schema_version: 1,
    policy_epoch: 1,
    server: { listen_host: "127.0.0.1", listen_port: listenPort, data_dir: dataDir },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: 64 * 1024 * 1024,
    },
    terminal: {
      backend: "pty",
      max_concurrent_sessions: maxConcurrentSessions,
      attach_history_bytes: 64 * 1024,
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
  const configPath = join(root, "config.yaml");
  writeConfigAtomic(configPath, config);
  const db = openDatabase(join(dataDir, "state.db"));
  databases.push(db);
  const operations = new OperationsRepo(db);
  const processes = new ProcessesRepo(db);
  const targets = new TargetRegistry(config);
  const terminalConfig = config.terminal;
  if (!terminalConfig) throw new Error("terminal fixture configuration is missing");
  const terminal = new PtySessionManager(dataDir, terminalConfig, { requireOwnership });
  const supervisor = new ProcessSupervisor({
    config,
    targets,
    policy: new PolicyEvaluator(config),
    operations,
    processes,
    terminal,
  });
  return { root, configPath, config, db, operations, processes, targets, terminal, supervisor };
}

function ttyInput(script: string, deadlineMs = 10_000, waitMs = 300) {
  return {
    idempotency_key: uuidv7(),
    target_id: "test",
    argv: ["node", "-e", script],
    cwd: ".",
    env: {},
    wait_ms: waitMs,
    deadline_ms: deadlineMs,
    max_output_bytes: 1024 * 1024,
    tty: true,
    columns: 100,
    rows: 30,
  };
}

function track(terminal: PtySessionManager, started: Record<string, unknown>): string {
  const session = String(started.terminal_session);
  sessions.push({ terminal, session });
  return session;
}

async function openRawAttachment(
  dataDir: string,
  session: string,
  readOnly: boolean,
  ownerGeneration?: number,
): Promise<{ socket: Socket; output(): string }> {
  const status = JSON.parse(readFileSync(join(dataDir, "sessions", session, "status.json"), "utf8")) as { ipc_token?: string };
  if (!status.ipc_token) throw new Error("PTY attachment fixture is missing ipc_token");
  const socket = createConnection(ptySocketPath(dataDir, session));
  attachments.push(socket);
  const output: Buffer[] = [];
  await new Promise<void>((resolveAttach, rejectAttach) => {
    let header = Buffer.alloc(0);
    const onError = (error: Error) => rejectAttach(error);
    const onData = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const newline = header.indexOf(10);
      if (newline < 0) return;
      const response = JSON.parse(header.subarray(0, newline).toString("utf8")) as { ok?: boolean; error?: string };
      if (!response.ok) {
        rejectAttach(new Error(response.error ?? "raw PTY attach failed"));
        return;
      }
      const rest = header.subarray(newline + 1);
      if (rest.length) output.push(rest);
      socket.off("error", onError);
      socket.off("data", onData);
      socket.on("data", (data) => output.push(Buffer.from(data)));
      resolveAttach();
    };
    socket.once("error", onError);
    socket.on("data", onData);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        op: "attach",
        read_only: readOnly,
        token: status.ipc_token,
        ...(ownerGeneration === undefined ? {} : { owner_generation: ownerGeneration }),
      })}\n`);
    });
  });
  return { socket, output: () => Buffer.concat(output).toString("utf8") };
}

async function unusedTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port fixture did not return a TCP port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

describe("durable interactive PTY process backend", () => {
  it("keeps a launching PTY pending while its worker status is still appearing", async () => {
    const { processes, supervisor } = fixture();
    const processId = "proc_launch_pending";
    processes.create({
      process_id: processId,
      idempotency_key: uuidv7(),
      target_id: "test",
      argv_digest: "sha256:launch-pending",
      cwd_relative: ".",
      backend: "pty",
      backend_ref: processId,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      max_output_bytes: 1024 * 1024,
    });

    await supervisor.reconcileInteractiveProcesses("test");

    expect(processes.get(processId)).toMatchObject({ state: "launching", reason: null, ended_at: null });
  });

  it("does not revive a terminal process record as running", () => {
    const { processes } = fixture();
    const processId = "proc_terminal_no_revive";
    processes.create({
      process_id: processId,
      idempotency_key: uuidv7(),
      target_id: "test",
      argv_digest: "sha256:no-revive",
      cwd_relative: ".",
      backend: "pty",
      backend_ref: processId,
    });
    processes.markTerminal(processId, "unknown", null, null, "launch_race_probe");
    const terminal = processes.get(processId);

    expect(processes.markRunning(processId, 123, null)).toBe(false);
    expect(processes.get(processId)).toMatchObject({ state: "unknown", reason: "launch_race_probe", ended_at: terminal?.ended_at });
  });

  it("waits through a transient missing status while an exit is settling", async () => {
    const { terminal, db } = fixture();
    const snapshots = [
      { exists: true, dead: false, exit_code: null, signal: null, reason: null, pid: 1, columns: 80, rows: 24 },
      { exists: false, dead: false, exit_code: null, signal: null, reason: null, pid: null, columns: null, rows: null },
      { exists: true, dead: true, exit_code: 1, signal: null, reason: "cancel_requested", pid: 1, columns: 80, rows: 24 },
    ];
    let index = 0;
    terminal.inspectSync = () => {
      const snapshot = snapshots[Math.min(index++, snapshots.length - 1)];
      if (!snapshot) throw new Error("transient status fixture is empty");
      return snapshot;
    };
    await expect(terminal.waitForExitStatus("transient", 250)).resolves.toMatchObject({
      exists: true,
      dead: true,
      reason: "cancel_requested",
    });
    db.close();
  });

  it("joins concurrent PTY starts with the same idempotency key before launch", async () => {
    const { supervisor, terminal, processes, db } = fixture();
    const input = ttyInput("setTimeout(()=>{},60000)", 10_000, 0);

    const [first, joined] = await Promise.all([
      supervisor.start(input, "req_pty_parallel_start_1"),
      supervisor.start(input, "req_pty_parallel_start_2"),
    ]);

    expect(joined.process_id).toBe(first.process_id);
    expect(processes.getByKey(input.idempotency_key)?.process_id).toBe(first.process_id);
    expect(
      (
        db.prepare("SELECT count(*) AS count FROM processes WHERE idempotency_key=?").get(input.idempotency_key) as {
          count: number;
        }
      ).count,
    ).toBe(1);
    track(terminal, first);
  });

  it("supports interactive input, polling, resize, attach metadata, and idempotent writes", async () => {
    const { supervisor, terminal, db } = fixture();
    const script = [
      "const readline=require('node:readline');",
      "const rl=readline.createInterface({input:process.stdin,output:process.stdout});",
      "console.log('READY');",
      "rl.question('NAME? ',name=>{console.log('HELLO '+name);rl.close();process.exit(0);});",
    ].join("");
    const started = await supervisor.start(ttyInput(script), "req_pty_start");
    track(terminal, started);
    expect(started.interactive).toBe(true);
    expect(started.backend).toBe("pty");
    expect(String(started.human_attach_command)).toContain("hostspan terminal attach --process");
    expect(String(started.human_attach_read_only_command)).toContain("--read-only");
    const startedBudget = started.output_budget as Record<string, unknown>;
    expect(startedBudget.scope).toBe("process_lifetime");
    expect(startedBudget.limit_bytes).toBe(1024 * 1024);
    expect(Number(startedBudget.used_bytes)).toBeGreaterThan(0);
    expect(startedBudget.remaining_bytes).toBe(1024 * 1024 - Number(startedBudget.used_bytes));

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
    expect(joined).toEqual(written);
    await expect(supervisor.write(writeInput)).resolves.toEqual(written);
    await expect(supervisor.write({ ...writeInput, chars: "duplicate" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    let current = written;
    let transcript = String(written.stdout ?? "");
    const completionAttempts = process.platform === "win32" ? 24 : 8;
    for (let attempt = 0; attempt < completionAttempts && (current.state === "running" || !transcript.includes("HELLO world")); attempt += 1) {
      current = await supervisor.poll({
        process_id: String(started.process_id),
        stdout_cursor: Number(current.next_stdout_cursor ?? 0),
        stderr_cursor: 0,
        wait_ms: 500,
        max_bytes: 64 * 1024,
      });
      transcript += String(current.stdout ?? "");
    }
    expect(transcript).toContain("HELLO world");
    expect(current.state).toBe("succeeded");
    const completedBudget = current.output_budget as Record<string, unknown>;
    expect(completedBudget.scope).toBe("process_lifetime");
    expect(completedBudget.limit_bytes).toBe(1024 * 1024);
    expect(Number(completedBudget.used_bytes)).toBeGreaterThanOrEqual(Number(startedBudget.used_bytes));
    expect(completedBudget.remaining_bytes).toBe(1024 * 1024 - Number(completedBudget.used_bytes));
    db.close();
  });

  it("reclaims a naturally exited PTY slot before admitting the next session", async () => {
    const { root, supervisor, terminal, processes, db } = fixture(true, 1);
    const first = await supervisor.start(
      ttyInput(
        "const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync('exit-now')){clearInterval(timer);process.exit(0)}},10)",
        10_000,
        0,
      ),
      "req_pty_slot_first",
    );
    const firstSession = track(terminal, first);
    expect(first.state).toBe("running");
    writeFileSync(join(root, "target", "exit-now"), "exit\n");
    await expect(terminal.waitForExitStatus(firstSession, process.platform === "win32" ? 5_000 : 2_000)).resolves.toMatchObject({
      exists: true,
      dead: true,
    });
    expect(processes.activeCountForTargetBackend("test", "pty")).toBe(1);

    const second = await supervisor.start(ttyInput("setTimeout(()=>process.exit(0),50)", 10_000, 0), "req_pty_slot_second");
    track(terminal, second);
    expect(String(second.process_id)).not.toBe(String(first.process_id));
    expect(processes.get(String(first.process_id))?.state).toBe("succeeded");

    await terminal.waitForExitStatus(String(second.terminal_session), process.platform === "win32" ? 5_000 : 2_000);
    await supervisor.reconcileInteractiveProcesses("test");
    expect(processes.activeCountForTargetBackend("test", "pty")).toBe(0);
    db.close();
  });

  it("keeps a live PTY process recoverable across HostSpan daemon restart", async () => {
    const first = fixture();
    const started = await first.supervisor.start(ttyInput("console.log('LIVE');setTimeout(()=>{},60000)"), "req_pty_persist_start");
    const session = track(first.terminal, started);
    expect(started.state).toBe("running");
    const processId = String(started.process_id);
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
    expect(first.terminal.inspectSync(session)).toMatchObject({ exists: true, dead: true, reason: "cancel_requested" });
    db.close();
  });

  it("does not claim PTY runtime ownership when serve cannot bind", async () => {
    const blocker = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => rejectListen(error);
      blocker.once("error", onError);
      blocker.listen(0, "127.0.0.1", () => {
        blocker.off("error", onError);
        resolveListen();
      });
    });
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("test blocker did not return a TCP port");
    const setup = fixture(true, 2, true, address.port);
    expect(runtimeGeneration(setup.db)).toBe(0);
    setup.db.close();

    try {
      await expect(main(["serve", "--config", setup.configPath])).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    }

    const check = openDatabase(join(setup.config.server.data_dir, "state.db"));
    try {
      expect(runtimeGeneration(check)).toBe(0);
    } finally {
      check.close();
    }
  });

  it.runIf(process.platform !== "win32")("does not claim PTY runtime ownership when daemon control setup cannot bind", async () => {
    const setup = fixture(true, 2, true, await unusedTcpPort());
    expect(runtimeGeneration(setup.db)).toBe(0);
    mkdirSync(join(setup.config.server.data_dir, "daemon-control.sock"), { recursive: true });
    setup.db.close();

    await expect(main(["serve", "--config", setup.configPath])).rejects.toBeInstanceOf(Error);

    const check = openDatabase(join(setup.config.server.data_dir, "state.db"));
    try {
      expect(runtimeGeneration(check)).toBe(0);
    } finally {
      check.close();
    }
  });

  it("increments PTY runtime generations monotonically", () => {
    const setup = fixture(true, 2, true);
    expect(runtimeGeneration(setup.db)).toBe(0);
    expect([claimRuntimeGeneration(setup.db), claimRuntimeGeneration(setup.db), claimRuntimeGeneration(setup.db)]).toEqual([1, 2, 3]);
    setup.db.close();
  });

  it("fences stale PTY owners after runtime generation takeover", async () => {
    const first = fixture(true, 2, true);
    const terminalConfig = first.config.terminal;
    if (!terminalConfig) throw new Error("terminal fixture configuration is missing");
    const generation1 = claimRuntimeGeneration(first.db);
    first.terminal.activateOwnership(generation1);
    const script = [
      "process.stdin.setEncoding('utf8');",
      "console.log('READY');",
      "process.stdin.on('data',chunk=>{console.log('GOT:'+chunk.trim());process.exit(0);});",
    ].join("");
    const started = await first.supervisor.start(ttyInput(script, 10_000, 300), "req_pty_owner_start");
    const session = String(started.terminal_session);
    sessions.push({ terminal: first.terminal, session });

    const secondTerminal = new PtySessionManager(first.config.server.data_dir, terminalConfig, { requireOwnership: true });
    const generation2 = claimRuntimeGeneration(first.db);
    expect(generation2).toBe(generation1 + 1);
    secondTerminal.activateOwnership(generation2);
    const tracked = sessions[sessions.length - 1];
    if (tracked) tracked.terminal = secondTerminal;

    await expect(first.terminal.write(session, { chars: "stale", control_keys: ["Enter"] })).rejects.toMatchObject({
      code: "SERVER_BUSY",
      retryable: true,
      details: { resource: "pty_runtime", reason: "stale_runtime_owner" },
    });
    await expect(first.terminal.close(session, 50)).rejects.toMatchObject({
      code: "SERVER_BUSY",
      details: { resource: "pty_runtime", reason: "stale_runtime_owner" },
    });

    await expect(secondTerminal.write(session, { chars: "fresh", control_keys: ["Enter"] })).resolves.toBeUndefined();
    const exited = await secondTerminal.waitForExitStatus(session, process.platform === "win32" ? 5_000 : 2_000);
    expect(exited).toMatchObject({ exists: true, dead: true });
    const stdout = readFileSync(join(first.config.server.data_dir, "spools", "processes", String(started.process_id), "stdout.bin"), "utf8");
    expect(stdout).toContain("GOT:fresh");
    first.db.close();
  });

  it("drops stale writable attachments while preserving read-only observation after takeover", async () => {
    const first = fixture(true, 2, true);
    const terminalConfig = first.config.terminal;
    if (!terminalConfig) throw new Error("terminal fixture configuration is missing");
    const generation1 = claimRuntimeGeneration(first.db);
    first.terminal.activateOwnership(generation1);
    const script = [
      "process.stdin.setEncoding('utf8');",
      "console.log('READY');",
      "process.stdin.on('data',chunk=>{const value=chunk.trim();console.log('GOT:'+value);if(value==='fresh')setTimeout(()=>process.exit(0),50);});",
    ].join("");
    const started = await first.supervisor.start(ttyInput(script, 10_000, 300), "req_pty_attach_owner_start");
    const session = String(started.terminal_session);
    sessions.push({ terminal: first.terminal, session });
    const writable = await openRawAttachment(first.config.server.data_dir, session, false, generation1);
    const readOnly = await openRawAttachment(first.config.server.data_dir, session, true);

    const secondTerminal = new PtySessionManager(first.config.server.data_dir, terminalConfig, { requireOwnership: true });
    const generation2 = claimRuntimeGeneration(first.db);
    expect(generation2).toBe(generation1 + 1);
    secondTerminal.activateOwnership(generation2);
    const tracked = sessions[sessions.length - 1];
    if (tracked) tracked.terminal = secondTerminal;

    const staleClosed = new Promise<void>((resolveClose) => writable.socket.once("close", () => resolveClose()));
    writable.socket.write("stale\r");
    await Promise.race([staleClosed, sleep(1_000)]);
    expect(writable.socket.destroyed).toBe(true);

    await secondTerminal.write(session, { chars: "fresh", control_keys: ["Enter"] });
    const exited = await secondTerminal.waitForExitStatus(session, process.platform === "win32" ? 5_000 : 2_000);
    expect(exited).toMatchObject({ exists: true, dead: true });
    for (let attempt = 0; attempt < 20 && !readOnly.output().includes("GOT:fresh"); attempt += 1) await sleep(25);
    expect(readOnly.output()).toContain("GOT:fresh");

    const stdout = readFileSync(
      join(first.config.server.data_dir, "spools", "processes", String(started.process_id), "stdout.bin"),
      "utf8",
    );
    expect(stdout).not.toContain("GOT:stale");
    expect(stdout).toContain("GOT:fresh");
    first.db.close();
  });

  it("kills PTY descendants when process_cancel terminates an interactive session", async () => {
    const { supervisor, terminal, db } = fixture();
    const script = [
      "const {spawn}=require('node:child_process');",
      "const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore',windowsHide:true});",
      "console.log('CHILD='+child.pid);",
      "setTimeout(()=>{},60000);",
    ].join("");
    const started = await supervisor.start(ttyInput(script, 20_000, 1_000), "req_pty_tree_cancel");
    track(terminal, started);
    let current = started;
    let transcript = String(started.stdout ?? "");
    for (let attempt = 0; attempt < 16 && !transcript.includes("CHILD="); attempt += 1) {
      current = await supervisor.poll({
        process_id: String(started.process_id),
        stdout_cursor: Number(current.next_stdout_cursor ?? 0),
        stderr_cursor: 0,
        wait_ms: 500,
        max_bytes: 64 * 1024,
      });
      transcript += String(current.stdout ?? "");
    }
    const match = /CHILD=(\d+)/.exec(transcript);
    if (!match?.[1]) throw new Error(`PTY descendant fixture did not report its child PID: ${transcript}`);
    const childPid = Number(match[1]);
    expect(pidAlive(childPid)).toBe(true);

    const cancelled = await supervisor.cancel({
      idempotency_key: uuidv7(),
      process_id: String(started.process_id),
      grace_ms: 200,
    });
    expect(cancelled.state).toBe("cancelled");
    for (let attempt = 0; attempt < 40 && pidAlive(childPid); attempt += 1) await sleep(50);
    expect(pidAlive(childPid)).toBe(false);
    db.close();
  }, 15_000);

  it.runIf(process.platform === "win32")("kills PTY descendants when synchronous recovery cleanup closes ConPTY", async () => {
    const { supervisor, terminal, db } = fixture();
    const script = [
      "const {spawn}=require('node:child_process');",
      "const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore',windowsHide:true});",
      "console.log('CHILD='+child.pid);",
      "setTimeout(()=>{},60000);",
    ].join("");
    const started = await supervisor.start(ttyInput(script, 20_000, 1_000), "req_pty_tree_cleanup");
    const session = track(terminal, started);
    let current = started;
    let transcript = String(started.stdout ?? "");
    for (let attempt = 0; attempt < 12 && !transcript.includes("CHILD="); attempt += 1) {
      current = await supervisor.poll({
        process_id: String(started.process_id),
        stdout_cursor: Number(current.next_stdout_cursor ?? 0),
        stderr_cursor: 0,
        wait_ms: 500,
        max_bytes: 64 * 1024,
      });
      transcript += String(current.stdout ?? "");
    }
    const match = /CHILD=(\d+)/.exec(transcript);
    if (!match?.[1]) throw new Error(`PTY descendant fixture did not report its child PID: ${transcript}`);
    const childPid = Number(match[1]);
    expect(pidAlive(childPid)).toBe(true);

    terminal.closeSync(session);
    await sleep(250);
    expect(pidAlive(childPid)).toBe(false);
    db.close();
  });

  it.runIf(process.platform === "win32")("preserves literal cmd/bat argv through the ConPTY worker", async () => {
    const { root, supervisor, terminal, db } = fixture();
    const targetRoot = join(root, "target");
    const output = join(targetRoot, "captured-argv.json");
    const helper = join(targetRoot, "capture.js");
    const commandFile = join(targetRoot, "capture args.cmd");
    const expected = [
      "",
      "space value",
      "amp&value",
      "pipe|value",
      "caret^value",
      "bang!value",
      "percent%HOSTSPAN_META%value",
      'quote"value',
      "paren(value)",
    ];
    writeFileSync(
      helper,
      "require('node:fs').writeFileSync(process.env.HOSTSPAN_ARGV_OUT,JSON.stringify(process.argv.slice(2)));process.stdout.write('CAPTURED')",
    );
    writeFileSync(commandFile, `@"${process.execPath}" "${helper}" %*\r\n`);
    const started = await supervisor.start(
      {
        ...ttyInput("", 10_000, 1_000),
        argv: [commandFile, ...expected],
        env: { HOSTSPAN_META: "EXPANDED", HOSTSPAN_ARGV_OUT: output },
      },
      "req_pty_cmd_argv",
    );
    track(terminal, started);
    let current = started;
    for (let attempt = 0; attempt < 16 && current.state === "running"; attempt += 1) {
      current = await supervisor.poll({
        process_id: String(started.process_id),
        stdout_cursor: Number(current.next_stdout_cursor ?? 0),
        stderr_cursor: 0,
        wait_ms: 500,
        max_bytes: 64 * 1024,
      });
    }
    expect(current.state).toBe("succeeded");
    expect(existsSync(output)).toBe(true);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(expected);
    db.close();
  });

  it("preserves final PTY output before recording terminal completion", async () => {
    const { supervisor, terminal, db } = fixture();
    const payload = `TAIL-${"x".repeat(16_384)}-END`;
    const started = await supervisor.start(ttyInput(`process.stdout.write(${JSON.stringify(payload)})`), "req_pty_drain");
    track(terminal, started);
    let current = started;
    let transcript = String(started.stdout ?? "");
    for (let attempt = 0; attempt < 8 && current.state === "running"; attempt += 1) {
      current = await supervisor.poll({
        process_id: String(started.process_id),
        stdout_cursor: Number(current.next_stdout_cursor ?? 0),
        stderr_cursor: 0,
        wait_ms: 500,
        max_bytes: 64 * 1024,
      });
      transcript += String(current.stdout ?? "");
    }
    expect(current.state).toBe("succeeded");
    expect(transcript).toContain("TAIL-");
    expect(transcript).toContain("-END");
    expect(terminal.outputBytes(String(started.process_id))).toBeGreaterThanOrEqual(Buffer.byteLength(payload));
    db.close();
  });

  it("enforces interactive deadlines in the session worker while the daemon is absent", async () => {
    const first = fixture();
    // ConPTY startup can take noticeably longer than Unix PTY creation. Keep
    // the deadline far enough beyond a successful start that this test proves
    // the detached worker, rather than the starting daemon, enforces it.
    const deadlineMs = process.platform === "win32" ? 3_000 : 400;
    const started = await first.supervisor.start(ttyInput("setTimeout(()=>{},60000)", deadlineMs, 0), "req_pty_deadline");
    track(first.terminal, started);
    expect(started.state).toBe("running");
    const processId = String(started.process_id);
    first.db.close();
    await sleep(deadlineMs + (process.platform === "win32" ? 1_000 : 300));

    const db = openDatabase(join(first.config.server.data_dir, "state.db"));
    const operations = new OperationsRepo(db);
    const processes = new ProcessesRepo(db);
    const recovered = recoverProcesses(processes, operations, first.terminal);
    expect(recovered).toContainEqual({ process_id: processId, state: "timed_out" });
    expect(processes.get(processId)).toMatchObject({ state: "timed_out", reason: "deadline_exceeded" });
    db.close();
  });

  it("classifies a vanished session worker as unknown instead of success", async () => {
    const first = fixture();
    const started = await first.supervisor.start(ttyInput("setTimeout(()=>{},60000)"), "req_pty_worker_crash");
    const session = track(first.terminal, started);
    const processId = String(started.process_id);
    const statusPath = join(first.config.server.data_dir, "sessions", session, "status.json");
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as { worker_pid: number };
    process.kill(status.worker_pid, "SIGKILL");
    await sleep(150);
    first.db.close();

    const db = openDatabase(join(first.config.server.data_dir, "state.db"));
    const operations = new OperationsRepo(db);
    const processes = new ProcessesRepo(db);
    expect(recoverProcesses(processes, operations, first.terminal)).toContainEqual({ process_id: processId, state: "unknown" });
    expect(processes.get(processId)).toMatchObject({ state: "unknown", reason: "pty_session_missing_after_restart" });
    db.close();
  });

  it("requires an explicit terminal capability even when exec is allowed", async () => {
    const { supervisor, db } = fixture(false);
    await expect(supervisor.start(ttyInput("setTimeout(()=>{},1000)"), "req_pty_denied")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    db.close();
  });
});
