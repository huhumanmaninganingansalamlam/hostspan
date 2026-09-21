import { createHash } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { v7 as uuidv7 } from "uuid";
import type { HostSpanConfig } from "../config/schema.js";
import { HostSpanError } from "../mcp/errors.js";
import type { ProcessCancelToolInput, ProcessPollToolInput, ProcessStartToolInput, ProcessWriteToolInput } from "../mcp/schemas.js";
import type { HostSpanLogger } from "../observability/logger.js";
import type { PolicyEvaluator } from "../policy/evaluator.js";
import type { OperationsRepo } from "../state/operations-repo.js";
import type { ProcessesRepo, ProcessState } from "../state/processes-repo.js";
import type { TargetRegistry } from "../targets/registry.js";
import { resolveTargetPath } from "../files/path-guard.js";
import { OutputSpool, processOutputBytes, processSpoolBytes } from "./output-spool.js";
import { processGroupAlive, signalProcessGroup } from "./recovery.js";
import type { InteractiveSessionManager } from "./interactive-session.js";
import { spawnWindowsJobProcess, type WindowsJobReceipt } from "./windows-job-process.js";

const TERMINAL_STATES = new Set<ProcessState>(["succeeded", "failed", "timed_out", "cancelled", "orphaned", "unknown"]);

type SupervisedChild = ChildProcessByStdio<null, Readable, Readable>;

interface RuntimeProcess {
  child: SupervisedChild;
  spool: OutputSpool;
  terminal: Promise<void>;
  resolveTerminal: () => void;
  closed: Promise<void>;
  resolveClosed: () => void;
  deadlineTimer?: NodeJS.Timeout;
  terminating: boolean;
  acceptingOutput: boolean;
  closedObserved: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

function digestArgv(argv: string[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(argv)).digest("hex")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGroupGone(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!processGroupAlive(pgid)) return true;
    await sleep(20);
  }
  return !processGroupAlive(pgid);
}

async function waitForWindowsProcessGone(pid: number | null, timeoutMs: number): Promise<boolean> {
  if (process.platform !== "win32" || !pid || pid <= 0) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(20);
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function safeKillGroup(pgid: number | null, signal: NodeJS.Signals): void {
  signalProcessGroup(pgid, signal);
}

export interface ProcessSupervisorOptions {
  config: HostSpanConfig;
  targets: TargetRegistry;
  policy: PolicyEvaluator;
  operations: OperationsRepo;
  processes: ProcessesRepo;
  terminal?: InteractiveSessionManager;
  logger?: HostSpanLogger;
}

export class ProcessSupervisor {
  private readonly runtimes = new Map<string, RuntimeProcess>();
  private readonly writeInflight = new Map<string, Promise<Record<string, unknown>>>();
  private readonly spoolReservations = new Map<string, number>();
  private readonly terminationInflight = new Map<string, Promise<ProcessState>>();

  constructor(private readonly options: ProcessSupervisorOptions) {
    for (const record of options.processes.active()) {
      if (record.max_output_bytes && record.max_output_bytes > 0) {
        this.spoolReservations.set(record.process_id, record.max_output_bytes);
      }
    }
  }

  private expiresAt(): string {
    const ttlMs = this.options.config.retention.completed_process_output_ttl_minutes * 60_000;
    return new Date(Date.now() + ttlMs).toISOString();
  }

  private spool(processId: string, maxOutputBytes = Number.MAX_SAFE_INTEGER): OutputSpool {
    const runtime = this.runtimes.get(processId);
    if (runtime) return runtime.spool;
    return new OutputSpool(this.options.config.server.data_dir, processId, maxOutputBytes);
  }

  private projectedSpoolBytes(): number {
    const dataDir = this.options.config.server.data_dir;
    let projected = processSpoolBytes(dataDir);
    for (const [processId, reserved] of this.spoolReservations) {
      projected += Math.max(0, reserved - processOutputBytes(dataDir, processId));
    }
    return projected;
  }

  private reserveSpoolBudget(processId: string, requestedBytes: number): number {
    const maximum = this.options.config.retention.max_total_spool_bytes;
    const projected = this.projectedSpoolBytes();
    const remaining = maximum - projected;
    if (remaining < requestedBytes) {
      throw new HostSpanError("SERVER_BUSY", "Process output retention budget cannot satisfy the requested output cap; retry after retained output expires.", true, {
        resource: "process_output_spool",
        retained_and_reserved_bytes: projected,
        requested_output_bytes: requestedBytes,
        remaining_output_bytes: Math.max(0, remaining),
        max_total_spool_bytes: maximum,
      });
    }
    this.spoolReservations.set(processId, requestedBytes);
    return requestedBytes;
  }

  private releaseSpoolReservation(processId: string): void {
    this.spoolReservations.delete(processId);
  }

  private finalize(
    processId: string,
    state: ProcessState,
    exitCode: number | null,
    signal: string | null,
    reason: string | null,
  ): void {
    const current = this.options.processes.get(processId);
    if (!current || TERMINAL_STATES.has(current.state)) {
      const runtime = this.runtimes.get(processId);
      if (runtime?.deadlineTimer) clearTimeout(runtime.deadlineTimer);
      runtime?.resolveTerminal();
      this.runtimes.delete(processId);
      this.releaseSpoolReservation(processId);
      return;
    }
    const expiresAt = this.expiresAt();
    this.options.processes.markTerminal(processId, state, exitCode, signal, reason, expiresAt);
    const result = {
      state,
      process_id: processId,
      exit_code: exitCode,
      signal,
      reason,
      output_expires_at: expiresAt,
      native_execution: true,
      sandboxed: false,
    };
    this.options.operations.setState(current.idempotency_key, state, result);
    this.options.logger?.info("process.completed", {
      process_id: processId,
      state,
      exit_code: exitCode,
      signal,
      reason,
    });
    const runtime = this.runtimes.get(processId);
    if (runtime?.deadlineTimer) clearTimeout(runtime.deadlineTimer);
    runtime?.resolveTerminal();
    this.runtimes.delete(processId);
    this.releaseSpoolReservation(processId);
  }

  async reconcileInteractiveProcesses(targetId?: string): Promise<void> {
    if (!this.options.terminal) return;
    const active = this.options.processes
      .active()
      .filter((record) => record.backend === "pty" && (targetId === undefined || record.target_id === targetId));
    for (const record of active) await this.syncInteractiveState(record.process_id);
  }

  private async terminateInteractive(
    processId: string,
    state: "timed_out" | "cancelled" | "failed",
    reason: string,
    graceMs = 500,
  ): Promise<ProcessState> {
    const record = this.options.processes.get(processId);
    if (!record) throw new HostSpanError("PROCESS_NOT_FOUND", `Unknown process_id: ${processId}`);
    if (TERMINAL_STATES.has(record.state)) return record.state;
    if (!this.options.terminal || !record.backend_ref) {
      this.finalize(processId, "unknown", record.exit_code, record.term_signal, "interactive_backend_unavailable");
      return "unknown";
    }
    await this.options.terminal.close(record.backend_ref, graceMs);
    const drained = await this.options.terminal.waitForOutputDrain(processId);
    this.options.processes.setBytes(processId, "stdout", drained.bytes);
    if (!drained.drained) {
      this.finalize(processId, "unknown", record.exit_code, record.term_signal, "interactive_output_drain_unconfirmed");
      return "unknown";
    }
    const settled = await this.options.terminal.waitForExitStatus(record.backend_ref, 250);
    if (!settled.exists) {
      this.finalize(processId, "unknown", record.exit_code, record.term_signal, "interactive_session_missing_after_terminate");
      return "unknown";
    }
    if (!settled.dead) {
      this.finalize(processId, "unknown", record.exit_code, record.term_signal, "interactive_session_still_running_after_terminate");
      return "unknown";
    }
    this.finalize(processId, state, settled.exit_code, settled.signal, reason);
    return state;
  }

  private terminate(
    processId: string,
    state: "timed_out" | "cancelled" | "failed",
    reason: string,
    graceMs: number,
  ): Promise<ProcessState> {
    const existing = this.terminationInflight.get(processId);
    if (existing) return existing;
    const operation = this.terminateOnce(processId, state, reason, graceMs).finally(() => {
      if (this.terminationInflight.get(processId) === operation) this.terminationInflight.delete(processId);
    });
    this.terminationInflight.set(processId, operation);
    return operation;
  }

  private async terminateOnce(
    processId: string,
    state: "timed_out" | "cancelled" | "failed",
    reason: string,
    graceMs: number,
  ): Promise<ProcessState> {
    const record = this.options.processes.get(processId);
    if (!record) throw new HostSpanError("PROCESS_NOT_FOUND", `Unknown process_id: ${processId}`);
    if (TERMINAL_STATES.has(record.state)) return record.state;
    const runtime = this.runtimes.get(processId);
    if (runtime) runtime.terminating = true;
    let gone: boolean;
    try {
      safeKillGroup(record.pgid, "SIGTERM");
      gone = record.pgid ? await waitForGroupGone(record.pgid, graceMs) : true;
      if (!gone) {
        safeKillGroup(record.pgid, "SIGKILL");
        gone = record.pgid ? await waitForGroupGone(record.pgid, 1_000) : true;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      this.finalize(processId, "unknown", record.exit_code, record.term_signal, `${reason}:termination_error:${code}`);
      return "unknown";
    }
    if (runtime) {
      // Process-tree death and Node stdio closure are separate facts. Do not
      // return a terminal result while stdout/stderr callbacks can still touch
      // durable state. A short grace normally observes `close`; if Node keeps
      // the pipe handles alive after the OS process tree is gone, stop
      // accepting output, destroy the pipes, and classify the boundary as
      // unknown unless close is then observed.
      await Promise.race([runtime.closed, sleep(2_000)]);
      if (!runtime.closedObserved) {
        runtime.acceptingOutput = false;
        runtime.child.stdout.destroy();
        runtime.child.stderr.destroy();
        await Promise.race([runtime.closed, sleep(500)]);
        if (!runtime.closedObserved) {
          this.finalize(processId, "unknown", runtime.exitCode, runtime.exitSignal, `${reason}:stdio_close_unconfirmed`);
          return "unknown";
        }
      }
    }
    const windowsTargetGone = await waitForWindowsProcessGone(record.pid, 1_500);
    if (process.platform === "win32" && windowsTargetGone) {
      // Job Object termination is kernel-owned, but process teardown can
      // release cwd/file handles a moment after the target PID disappears.
      // Do not return cancellation while ordinary follow-up file operations
      // are still racing that teardown.
      await sleep(100);
    }
    const refreshedRuntime = this.runtimes.get(processId);
    const exitCode = refreshedRuntime?.exitCode ?? this.options.processes.get(processId)?.exit_code ?? null;
    const signal = refreshedRuntime?.exitSignal ?? this.options.processes.get(processId)?.term_signal ?? null;
    if (!gone) {
      this.finalize(processId, "orphaned", exitCode, signal, `${reason}:process_group_still_alive`);
      return "orphaned";
    }
    if (!windowsTargetGone) {
      this.finalize(processId, "orphaned", exitCode, signal, `${reason}:windows_job_target_still_alive`);
      return "orphaned";
    }
    this.finalize(processId, state, exitCode, signal, reason);
    return state;
  }

  private async waitForTerminal(processId: string, waitMs: number): Promise<void> {
    if (waitMs <= 0) return;
    const record = this.options.processes.get(processId);
    if (!record || TERMINAL_STATES.has(record.state)) return;
    const runtime = this.runtimes.get(processId);
    if (!runtime) return;
    await Promise.race([runtime.terminal, sleep(waitMs)]);
  }

  private snapshot(processId: string, stdoutCursor: number, stderrCursor: number, maxBytes: number): Record<string, unknown> {
    const record = this.options.processes.get(processId);
    if (!record) throw new HostSpanError("PROCESS_NOT_FOUND", `Unknown process_id: ${processId}`);
    if (record.output_expires_at && record.output_expires_at <= new Date().toISOString()) {
      const unread = stdoutCursor < record.stdout_bytes || stderrCursor < record.stderr_bytes;
      if (unread) {
        throw new HostSpanError("CURSOR_EXPIRED", "Process output has expired from retention storage.", false, {
          stdout_earliest_cursor: record.stdout_bytes,
          stderr_earliest_cursor: record.stderr_bytes,
        });
      }
    }
    const interactive = record.backend === "pty";
    const perStream = interactive ? maxBytes : Math.max(1, Math.floor(maxBytes / 2));
    const spool = this.spool(processId, record.max_output_bytes ?? Number.MAX_SAFE_INTEGER);
    const stdout = spool.read("stdout", stdoutCursor, perStream);
    const stderr = interactive
      ? { text: "", next_cursor: stderrCursor, earliest_cursor: 0, bytes_returned: 0 }
      : spool.read("stderr", stderrCursor, perStream);
    return {
      state: record.state,
      process_id: processId,
      stdout: stdout.text,
      stderr: stderr.text,
      next_stdout_cursor: stdout.next_cursor,
      next_stderr_cursor: stderr.next_cursor,
      exit_code: record.exit_code,
      signal: record.term_signal,
      reason: record.reason,
      output_expires_at: record.output_expires_at,
      backend: record.backend,
      interactive,
      ...(interactive && record.backend_ref && this.options.terminal
        ? {
            terminal_session: record.backend_ref,
            human_attach_command: this.options.terminal.humanAttachCommand(record.backend_ref, false),
            human_attach_read_only_command: this.options.terminal.humanAttachCommand(record.backend_ref, true),
          }
        : {}),
      native_execution: true,
      sandboxed: false,
    };
  }

  private async syncInteractiveState(processId: string): Promise<void> {
    const record = this.options.processes.get(processId);
    if (!record || record.backend !== "pty" || TERMINAL_STATES.has(record.state)) return;
    if (!this.options.terminal || !record.backend_ref) {
      this.finalize(processId, "unknown", record.exit_code, record.term_signal, "interactive_backend_unavailable");
      return;
    }
    let bytes = this.options.terminal.outputBytes(processId);
    this.options.processes.setBytes(processId, "stdout", bytes);
    const state = await this.options.terminal.inspect(record.backend_ref);
    if (!state.exists) {
      this.finalize(processId, "unknown", record.exit_code, record.term_signal, "interactive_session_missing");
      return;
    }
    if (state.dead) {
      const drained = await this.options.terminal.waitForOutputDrain(processId);
      bytes = drained.bytes;
      this.options.processes.setBytes(processId, "stdout", bytes);
      if (!drained.drained) {
        this.finalize(processId, "unknown", state.exit_code, state.signal, "interactive_output_drain_unconfirmed");
        return;
      }
      const settled = state.exit_code === null ? await this.options.terminal.waitForExitStatus(record.backend_ref) : state;
      if (!settled.exists) {
        this.finalize(processId, "unknown", null, null, "interactive_exit_status_unavailable");
        return;
      }
      if (settled.reason === "deadline_exceeded") {
        this.finalize(processId, "timed_out", settled.exit_code, settled.signal, "deadline_exceeded");
        return;
      }
      if (settled.reason === "output_limit") {
        this.finalize(processId, "failed", settled.exit_code, settled.signal, "output_limit");
        return;
      }
      if (settled.reason === "cancel_requested") {
        this.finalize(processId, "cancelled", settled.exit_code, settled.signal, "cancel_requested");
        return;
      }
      if (settled.exit_code === null) {
        this.finalize(processId, "unknown", null, settled.signal, "interactive_exit_status_unavailable");
        return;
      }
      this.finalize(
        processId,
        settled.exit_code === 0 ? "succeeded" : "failed",
        settled.exit_code,
        settled.signal,
        settled.exit_code === 0 ? null : "nonzero_exit",
      );
    }
  }

  async start(input: ProcessStartToolInput, requestId: string): Promise<Record<string, unknown>> {
    const interactive = input.tty ?? false;
    const target = this.options.targets.get(input.target_id, interactive ? "terminal" : "exec");
    const cwd = resolveTargetPath(target, input.cwd, "exec");
    if (!cwd.exists) throw new HostSpanError("FILE_NOT_FOUND", `Process cwd does not exist: ${input.cwd}`);
    const profile = interactive ? undefined : this.options.policy.validateExec(target, input.argv, input.env, input.deadline_ms, input.max_output_bytes);
    const resolution = this.options.operations.resolve(input.idempotency_key, "process_start", input, input.target_id);
    if (resolution.kind !== "new") {
      const existing = this.options.processes.getByKey(input.idempotency_key);
      if (!existing) {
        if (resolution.kind === "replay" && resolution.error) throw resolution.error;
        if (resolution.kind === "unknown") return { state: "unknown", reason: "process_record_missing", native_execution: true, sandboxed: false };
        throw new HostSpanError("PROCESS_UNKNOWN", "Durable operation exists but its process record is missing.");
      }
      if (resolution.kind === "unknown" || existing.state === "unknown") {
        return this.snapshot(existing.process_id, 0, 0, Math.min(input.max_output_bytes, 131_072));
      }
      if (existing.backend === "pty") {
        await this.syncInteractiveState(existing.process_id);
      } else {
        await this.waitForTerminal(existing.process_id, input.wait_ms);
      }
      return this.snapshot(existing.process_id, 0, 0, Math.min(input.max_output_bytes, 131_072));
    }

    if (interactive) {
      if (!this.options.terminal || !this.options.config.terminal) {
        const error = new HostSpanError("TERMINAL_BACKEND_UNAVAILABLE", "Interactive terminal support is not configured.", true);
        this.options.operations.setState(input.idempotency_key, "failed", undefined, error);
        throw error;
      }
      await this.reconcileInteractiveProcesses(input.target_id);
      if (this.options.processes.activeCountForTargetBackend(input.target_id, "pty") >= this.options.config.terminal.max_concurrent_sessions) {
        const error = new HostSpanError("SCOPE_DENIED", `Target ${input.target_id} reached max_concurrent_terminal_sessions.`, false, {
          reason: "max_concurrent_terminal_sessions",
        });
        this.options.operations.setState(input.idempotency_key, "failed", undefined, error);
        throw error;
      }
      const processId = `proc_${uuidv7().replaceAll("-", "")}`;
      let effectiveMaxOutputBytes: number;
      try {
        effectiveMaxOutputBytes = this.reserveSpoolBudget(
          processId,
          Math.min(input.max_output_bytes, this.options.config.terminal.max_output_bytes),
        );
      } catch (error) {
        this.options.operations.setState(input.idempotency_key, "failed", undefined, error);
        throw error;
      }
      const session = this.options.terminal.sessionName(processId);
      const deadlineAt = new Date(Date.now() + input.deadline_ms).toISOString();
      try {
        this.options.processes.create({
          process_id: processId,
          idempotency_key: input.idempotency_key,
          target_id: input.target_id,
          argv_digest: digestArgv(input.argv),
          cwd_relative: cwd.relative,
          backend: "pty",
          backend_ref: session,
          deadline_at: deadlineAt,
          max_output_bytes: effectiveMaxOutputBytes,
        });
      } catch (error) {
        this.releaseSpoolReservation(processId);
        this.options.operations.setState(input.idempotency_key, "failed", undefined, error);
        throw error;
      }
      this.options.operations.setState(input.idempotency_key, "launching", { state: "launching", process_id: processId, backend: "pty" });
      this.options.logger?.info("process.launching", {
        request_id: requestId,
        process_id: processId,
        target_id: input.target_id,
        argv_digest: digestArgv(input.argv),
        cwd: cwd.relative,
        backend: "pty",
      });
      try {
        const started = await this.options.terminal.start({
          processId,
          cwd: cwd.absolute,
          argv: input.argv,
          env: input.env,
          columns: input.columns ?? 120,
          rows: input.rows ?? 40,
          deadlineAt,
          maxOutputBytes: effectiveMaxOutputBytes,
        });
        this.options.processes.markRunning(processId, started.pid, null);
        this.options.operations.setState(input.idempotency_key, "running", { state: "running", process_id: processId, backend: "pty" });
        this.options.logger?.info("process.started", { request_id: requestId, process_id: processId, pid: started.pid, backend: "pty", session });
        const beforeBytes = this.options.terminal.outputBytes(processId);
        await this.options.terminal.waitForActivity(session, processId, beforeBytes, input.wait_ms);
        await this.syncInteractiveState(processId);
        return this.snapshot(processId, 0, 0, Math.min(input.max_output_bytes, 131_072));
      } catch (error) {
        this.releaseSpoolReservation(processId);
        this.options.processes.markTerminal(processId, "failed", null, null, "pty_start_failed", this.expiresAt());
        this.options.operations.setState(input.idempotency_key, "failed", { state: "failed", process_id: processId, reason: "pty_start_failed" }, error);
        throw error;
      }
    }

    if (!profile) throw new HostSpanError("POLICY_UNENFORCEABLE", "Missing native exec profile.");
    if (this.options.processes.activeCountForTargetBackend(input.target_id, "native") >= profile.max_concurrent_processes) {
      const error = new HostSpanError("SCOPE_DENIED", `Target ${input.target_id} reached max_concurrent_processes.`, false, {
        reason: "max_concurrent_processes",
      });
      this.options.operations.setState(input.idempotency_key, "failed", undefined, error);
      throw error;
    }

    const processId = `proc_${uuidv7().replaceAll("-", "")}`;
    let effectiveMaxOutputBytes: number;
    try {
      effectiveMaxOutputBytes = this.reserveSpoolBudget(processId, input.max_output_bytes);
    } catch (error) {
      this.options.operations.setState(input.idempotency_key, "failed", undefined, error);
      throw error;
    }
    const deadlineAt = new Date(Date.now() + input.deadline_ms).toISOString();
    try {
      this.options.processes.create({
        process_id: processId,
        idempotency_key: input.idempotency_key,
        target_id: input.target_id,
        argv_digest: digestArgv(input.argv),
        cwd_relative: cwd.relative,
        backend: "native",
        backend_ref: null,
        deadline_at: deadlineAt,
        max_output_bytes: effectiveMaxOutputBytes,
      });
    } catch (error) {
      this.releaseSpoolReservation(processId);
      this.options.operations.setState(input.idempotency_key, "failed", undefined, error);
      throw error;
    }
    this.options.operations.setState(input.idempotency_key, "launching", { state: "launching", process_id: processId });
    this.options.logger?.info("process.launching", {
      request_id: requestId,
      process_id: processId,
      target_id: input.target_id,
      argv_digest: digestArgv(input.argv),
      cwd: cwd.relative,
    });

    let child: SupervisedChild;
    let windowsReady: Promise<WindowsJobReceipt> | undefined;
    try {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: process.env.LANG ?? "C.UTF-8",
        ...input.env,
      };
      const program = input.argv[0];
      if (!program) throw new HostSpanError("SCOPE_DENIED", "Process argv must include a program.");
      if (process.platform === "win32") {
        const launched = spawnWindowsJobProcess({
          dataDir: this.options.config.server.data_dir,
          processId,
          cwd: cwd.absolute,
          argv: input.argv,
          env,
        });
        child = launched.child;
        windowsReady = launched.ready;
      } else {
        child = spawn(program, input.argv.slice(1), {
          cwd: cwd.absolute,
          env,
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
    } catch (error) {
      this.releaseSpoolReservation(processId);
      this.options.processes.markTerminal(processId, "failed", null, null, "spawn_failed", this.expiresAt());
      this.options.operations.setState(input.idempotency_key, "failed", { state: "failed", process_id: processId, reason: "spawn_failed" }, error);
      throw error;
    }

    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const runtime: RuntimeProcess = {
      child,
      spool: new OutputSpool(this.options.config.server.data_dir, processId, effectiveMaxOutputBytes),
      terminal,
      resolveTerminal,
      closed,
      resolveClosed,
      terminating: false,
      acceptingOutput: true,
      closedObserved: false,
      exitCode: null,
      exitSignal: null,
    };
    this.runtimes.set(processId, runtime);

    const onOutput = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (!runtime.acceptingOutput) return;
      const current = this.options.processes.get(processId);
      if (!current || TERMINAL_STATES.has(current.state)) return;
      const appended = runtime.spool.append(stream, Buffer.from(chunk));
      if (appended.written > 0) this.options.processes.addBytes(processId, stream, appended.written);
      if (appended.limit_exceeded && !runtime.terminating) {
        void this.terminate(processId, "failed", "output_limit", 250);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => onOutput("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => onOutput("stderr", chunk));

    const markRunning = (pid: number, groupId: number): void => {
      const current = this.options.processes.get(processId);
      if (!current || TERMINAL_STATES.has(current.state)) return;
      this.options.processes.markRunning(processId, pid, groupId);
      this.options.operations.setState(input.idempotency_key, "running", { state: "running", process_id: processId });
      this.options.logger?.info("process.started", { request_id: requestId, process_id: processId, pid, pgid: groupId });
      runtime.deadlineTimer = setTimeout(() => {
        void this.terminate(processId, "timed_out", "deadline_exceeded", process.platform === "win32" ? 0 : 1_000);
      }, input.deadline_ms);
      runtime.deadlineTimer.unref();
    };

    child.once("error", (error) => {
      runtime.closedObserved = true;
      runtime.resolveClosed();
      if (runtime.terminating) return;
      runtime.terminating = true;
      this.finalize(processId, "failed", null, null, `spawn_error:${error.message}`);
    });

    child.once("close", (code, signal) => {
      runtime.closedObserved = true;
      runtime.exitCode = code;
      runtime.exitSignal = signal;
      runtime.resolveClosed();
      if (runtime.terminating) return;
      const state: ProcessState = code === 0 ? "succeeded" : "failed";
      this.finalize(processId, state, code, signal, code === 0 ? null : "nonzero_exit");
    });

    if (windowsReady) {
      try {
        const receipt = await windowsReady;
        markRunning(receipt.targetPid, receipt.workerPid);
      } catch (error) {
        runtime.terminating = true;
        if (child.pid) {
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {
            // The worker may already have exited after reporting launch failure.
          }
        }
        const current = this.options.processes.get(processId);
        if (current && !TERMINAL_STATES.has(current.state)) {
          this.finalize(processId, "failed", null, null, `spawn_error:${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      }
    } else {
      child.once("spawn", () => {
        const pid = child.pid;
        if (!pid) {
          this.finalize(processId, "unknown", null, null, "spawn_receipt_missing_pid");
          return;
        }
        markRunning(pid, pid);
      });
    }

    await this.waitForTerminal(processId, input.wait_ms);
    const afterWait = this.options.processes.get(processId);
    if (afterWait && !TERMINAL_STATES.has(afterWait.state) && deadlineAt <= new Date().toISOString()) {
      await this.terminate(processId, "timed_out", "deadline_exceeded", process.platform === "win32" ? 0 : 1_000);
    }
    return this.snapshot(processId, 0, 0, Math.min(input.max_output_bytes, 131_072));
  }

  async poll(input: ProcessPollToolInput): Promise<Record<string, unknown>> {
    const record = this.options.processes.get(input.process_id);
    if (!record) throw new HostSpanError("PROCESS_NOT_FOUND", `Unknown process_id: ${input.process_id}`);
    if (record.backend === "pty") {
      if (!this.options.terminal || !record.backend_ref) throw new HostSpanError("TERMINAL_BACKEND_UNAVAILABLE", "PTY terminal backend is unavailable.", true);
      const previousBytes = this.options.terminal.outputBytes(input.process_id);
      if (previousBytes <= input.stdout_cursor && !TERMINAL_STATES.has(record.state)) {
        await this.options.terminal.waitForActivity(record.backend_ref, input.process_id, previousBytes, input.wait_ms);
      }
      await this.syncInteractiveState(input.process_id);
    } else {
      await this.waitForTerminal(input.process_id, input.wait_ms);
    }
    return this.snapshot(input.process_id, input.stdout_cursor, input.stderr_cursor, input.max_bytes);
  }

  async write(input: ProcessWriteToolInput): Promise<Record<string, unknown>> {
    const record = this.options.processes.get(input.process_id);
    if (!record) throw new HostSpanError("PROCESS_NOT_FOUND", `Unknown process_id: ${input.process_id}`);
    if (record.backend !== "pty" || !record.backend_ref) {
      throw new HostSpanError("TERMINAL_NOT_INTERACTIVE", "process_write requires an interactive process started with tty=true.");
    }
    this.options.targets.get(record.target_id, "terminal");
    if (!this.options.terminal) throw new HostSpanError("TERMINAL_BACKEND_UNAVAILABLE", "PTY terminal backend is unavailable.", true);
    const resolution = this.options.operations.resolve(input.idempotency_key, "process_write", input, record.target_id);
    if (resolution.kind === "replay") {
      return (resolution.result as Record<string, unknown> | null) ?? this.snapshot(input.process_id, input.stdout_cursor, 0, input.max_bytes);
    }
    if (resolution.kind === "unknown") {
      throw new HostSpanError("PROCESS_UNKNOWN", "Interactive input outcome is unknown; do not replay it automatically.", false, {
        process_id: input.process_id,
        idempotency_key: input.idempotency_key,
      });
    }
    if (resolution.kind === "join") {
      const joined = this.writeInflight.get(input.idempotency_key);
      if (joined) return joined;
      this.options.operations.setState(input.idempotency_key, "unknown", {
        state: "unknown",
        process_id: input.process_id,
        reason: "interactive_write_restart_boundary",
      });
      throw new HostSpanError("PROCESS_UNKNOWN", "Interactive input may have crossed a daemon restart boundary; it was not replayed.", false, {
        process_id: input.process_id,
        idempotency_key: input.idempotency_key,
      });
    }

    const operation = this.performWrite(input, record.backend_ref);
    this.writeInflight.set(input.idempotency_key, operation);
    try {
      return await operation;
    } finally {
      this.writeInflight.delete(input.idempotency_key);
    }
  }

  private async performWrite(input: ProcessWriteToolInput, session: string): Promise<Record<string, unknown>> {
    if (!this.options.terminal) throw new HostSpanError("TERMINAL_BACKEND_UNAVAILABLE", "PTY terminal backend is unavailable.", true);
    await this.syncInteractiveState(input.process_id);
    const refreshed = this.options.processes.get(input.process_id);
    if (!refreshed || TERMINAL_STATES.has(refreshed.state)) {
      const result = this.snapshot(input.process_id, input.stdout_cursor, 0, input.max_bytes);
      this.options.operations.setState(input.idempotency_key, "succeeded", result);
      return result;
    }
    this.options.operations.setState(input.idempotency_key, "running", { state: "writing", process_id: input.process_id });
    const previousBytes = this.options.terminal.outputBytes(input.process_id);
    try {
      await this.options.terminal.write(session, {
        chars: input.chars,
        control_keys: input.control_keys,
        ...(input.columns !== undefined ? { columns: input.columns } : {}),
        ...(input.rows !== undefined ? { rows: input.rows } : {}),
      });
      await this.options.terminal.waitForActivity(session, input.process_id, previousBytes, input.wait_ms);
      await this.syncInteractiveState(input.process_id);
      const result = this.snapshot(input.process_id, input.stdout_cursor, 0, input.max_bytes);
      this.options.operations.setState(input.idempotency_key, "succeeded", result);
      return result;
    } catch (error) {
      const unknown = {
        state: "unknown",
        process_id: input.process_id,
        reason: "interactive_write_outcome_unknown",
      };
      this.options.operations.setState(input.idempotency_key, "unknown", unknown, error);
      throw new HostSpanError("PROCESS_UNKNOWN", "Interactive input outcome could not be proven; it was not replayed.", false, {
        process_id: input.process_id,
        idempotency_key: input.idempotency_key,
      });
    }
  }

  async cancel(input: ProcessCancelToolInput): Promise<Record<string, unknown>> {
    const record = this.options.processes.get(input.process_id);
    if (!record) throw new HostSpanError("PROCESS_NOT_FOUND", `Unknown process_id: ${input.process_id}`);
    const resolution = this.options.operations.resolve(input.idempotency_key, "process_cancel", input, record.target_id);
    if (resolution.kind === "replay" || resolution.kind === "unknown") {
      return (resolution.result as Record<string, unknown> | null) ?? this.snapshot(input.process_id, 0, 0, 131_072);
    }
    if (record.state === "orphaned" && processGroupAlive(record.pgid)) {
      safeKillGroup(record.pgid, "SIGTERM");
      let gone = record.pgid ? await waitForGroupGone(record.pgid, input.grace_ms) : true;
      if (!gone) {
        safeKillGroup(record.pgid, "SIGKILL");
        gone = record.pgid ? await waitForGroupGone(record.pgid, 1_000) : true;
      }
      const state: ProcessState = gone ? "cancelled" : "orphaned";
      this.options.processes.markTerminal(record.process_id, state, record.exit_code, record.term_signal, gone ? "cancel_requested_after_recovery" : "orphaned_process_group_still_alive", this.expiresAt());
      const result = this.snapshot(input.process_id, 0, 0, 131_072);
      this.options.operations.setState(input.idempotency_key, gone ? "succeeded" : "unknown", result);
      return result;
    }
    if (TERMINAL_STATES.has(record.state)) {
      const result = this.snapshot(input.process_id, 0, 0, 131_072);
      this.options.operations.setState(input.idempotency_key, "succeeded", result);
      return result;
    }
    this.options.operations.setState(input.idempotency_key, "running", { state: "cancelling", process_id: input.process_id });
    if (record.backend === "pty") {
      const terminalState = await this.terminateInteractive(input.process_id, "cancelled", "cancel_requested", input.grace_ms);
      const result = this.snapshot(input.process_id, 0, 0, 131_072);
      this.options.operations.setState(input.idempotency_key, terminalState === "unknown" ? "unknown" : "succeeded", result);
      return result;
    }
    const terminalState = await this.terminate(input.process_id, "cancelled", "cancel_requested", input.grace_ms);
    const result = this.snapshot(input.process_id, 0, 0, 131_072);
    this.options.operations.setState(input.idempotency_key, terminalState === "orphaned" ? "unknown" : "succeeded", result);
    return result;
  }

  async shutdown(): Promise<void> {
    const active = this.options.processes.active().filter((record) => record.backend === "native");
    await Promise.allSettled(
      active.map(async (record) => {
        try {
          await this.terminate(record.process_id, "cancelled", "daemon_shutdown", 500);
        } catch {
          // Shutdown is best-effort; recovery will classify any surviving process honestly on next start.
        }
      }),
    );
    await Promise.allSettled([...this.terminationInflight.values()]);
  }

  async settleForRuntimeClose(): Promise<void> {
    await Promise.allSettled([...this.terminationInflight.values(), ...this.writeInflight.values()]);
    if (this.runtimes.size > 0) {
      throw new Error(
        `Cannot close HostSpan runtime while ${this.runtimes.size} native process runtime(s) are still active; shut down the supervisor first.`,
      );
    }
  }
}
