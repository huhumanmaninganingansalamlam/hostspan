import { completeProcess } from "./completion.js";
import { terminateWorkerSession, terminateProcessTree, safeKillGroup, waitForGroupGone } from "./termination.js";
import { TERMINAL_STATES } from "./state-machine.js";
import { launchDirectNativeProcess } from "./direct-native-launch.js";
import { launchWorkerBackedProcess } from "./worker-launch.js";
import { resolveProcessAdmission } from "./admission.js";
import { buildProcessSnapshot, type ProcessSnapshot } from "./snapshot.js";
import { createHash } from "node:crypto";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { v7 as uuidv7 } from "uuid";
import type { HostSpanConfig } from "../config/schema.js";
import { asHostSpanError, HostSpanError } from "../errors.js";
import type { ProcessCancelToolInput, ProcessPollToolInput, ProcessStartToolInput, ProcessWriteToolInput } from "../tools/schemas.js";
import type { OperationsStore } from "../operations/store.js";
import type { HostSpanLogger } from "../observability/logger.js";
import type { PolicyEvaluator } from "../policy/evaluator.js";
import type { TargetRegistry } from "../targets/registry.js";
import type { ProcessesStore, ProcessState, ProcessRecord } from "./store.js";
import { OutputSpool } from "./output-spool.js";
import { processGroupAlive, } from "./recovery.js";
import type { InteractiveSessionManager } from "./interactive-session.js";


export type SupervisedChild = ChildProcessByStdio<null, Readable, Readable>;

export interface RuntimeProcess {
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

function writeObservationError(error: unknown, input: ProcessWriteToolInput): HostSpanError {
  const cause = asHostSpanError(error);
  return new HostSpanError(cause.code, cause.message, cause.retryable, {
    ...cause.details,
    process_id: input.process_id,
    idempotency_key: input.idempotency_key,
    input_delivered: true,
    phase: "output_observation",
  });
}

function digestArgv(argv: string[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(argv)).digest("hex")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ProcessSupervisorOptions {
  config: HostSpanConfig;
  targets: TargetRegistry;
  policy: PolicyEvaluator;
  operations: OperationsStore;
  processes: ProcessesStore;
  terminal?: InteractiveSessionManager;
  native?: InteractiveSessionManager;
  logger?: HostSpanLogger;
}

export class ProcessSupervisor {
  private readonly runtimes = new Map<string, RuntimeProcess>();
  private readonly writeInflight = new Map<string, Promise<Record<string, unknown>>>();
  private readonly cancelInflight = new Map<string, Promise<Record<string, unknown>>>();
  private readonly terminationInflight = new Map<string, Promise<ProcessState>>();

  constructor(private readonly options: ProcessSupervisorOptions) {}

  private sessionManager(record: ProcessRecord): InteractiveSessionManager | undefined {
    return record.backend === "pty" ? this.options.terminal : record.backend_ref ? this.options.native : undefined;
  }

  private syncOutput(record: ProcessRecord, manager: InteractiveSessionManager): void {
    this.options.processes.setBytes(record.process_id, "stdout", manager.outputBytes(record.process_id));
    if (record.backend === "native") this.options.processes.setBytes(record.process_id, "stderr", manager.outputBytes(record.process_id, "stderr"));
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

  private finalize(processId: string, state: ProcessState, exitCode: number | null, signal: string | null, reason: string | null, endedAt?: string): void {
    completeProcess(this.options, this.runtimes, () => this.expiresAt(), processId, state, exitCode, signal, reason, endedAt);
  }

  async reconcileInteractiveProcesses(targetId?: string): Promise<void> {
    for (const record of this.options.processes.active()) {
      if ((!targetId || record.target_id === targetId) && (record.backend === "pty" || record.backend_ref)) await this.syncSessionState(record.process_id);
    }
  }

  private terminateSession(
    processId: string, state: "timed_out" | "cancelled" | "failed", reason: string, graceMs = 500
  ): Promise<ProcessState> {
    return terminateWorkerSession({
      options: this.options,
      sessionManager: (record) => this.sessionManager(record),
      finalize: (id, status, code, signal, why, endedAt) => this.finalize(id, status, code, signal, why, endedAt),
      syncOutput: (record, manager) => this.syncOutput(record, manager),
    }, processId, state, reason, graceMs);
  }

  private terminate(
    processId: string,
    state: "timed_out" | "cancelled" | "failed",
    reason: string,
    graceMs: number,
  ): Promise<ProcessState> {
    const existing = this.terminationInflight.get(processId);
    if (existing) return existing;
    const operation = terminateProcessTree({
      options: this.options,
      runtimes: this.runtimes,
      finalize: (id, status, code, signal, why) => this.finalize(id, status, code, signal, why),
    }, processId, state, reason, graceMs).finally(() => {
      if (this.terminationInflight.get(processId) === operation) this.terminationInflight.delete(processId);
    });
    this.terminationInflight.set(processId, operation);
    return operation;
  }

  private async waitForTerminal(processId: string, waitMs: number): Promise<void> {
    if (waitMs <= 0) return;
    const record = this.options.processes.get(processId);
    if (!record || TERMINAL_STATES.has(record.state)) return;
    const runtime = this.runtimes.get(processId);
    if (!runtime) return;
    await Promise.race([runtime.terminal, sleep(waitMs)]);
  }

  private snapshot(processId: string, stdoutCursor: number, stderrCursor: number, maxBytes: number): ProcessSnapshot {
    const record = this.options.processes.get(processId);
    if (!record) throw new HostSpanError("PROCESS_NOT_FOUND", `Unknown process_id: ${processId}`);
    return buildProcessSnapshot(record, this.spool(processId, record.max_output_bytes ?? Number.MAX_SAFE_INTEGER), stdoutCursor, stderrCursor, maxBytes, this.options.terminal);
  }

  private async syncSessionState(processId: string): Promise<void> {
    const record = this.options.processes.get(processId);
    if (!record || TERMINAL_STATES.has(record.state)) return;
    const manager = this.sessionManager(record);
    if (!manager || !record.backend_ref) {
      this.finalize(processId, "unknown", record.exit_code, record.term_signal, "interactive_backend_unavailable");
      return;
    }
    this.syncOutput(record, manager);
    const state = await manager.inspect(record.backend_ref);
    if (!state.exists) {
      if (record.state === "launching") return;
      this.finalize(processId, "unknown", record.exit_code, record.term_signal, "interactive_session_missing");
      return;
    }
    if (!state.dead && record.state === "launching" && state.pid !== null) {
      this.options.processes.markRunning(processId, state.pid, record.backend === "native" && process.platform !== "win32" ? state.pid : null);
      this.options.operations.setState(record.idempotency_key, "running", { state: "running", process_id: processId, backend: record.backend });
    }
    if (state.dead) {
      const drained = await manager.waitForOutputDrain(processId);
      this.syncOutput(record, manager);
      if (!drained.drained) {
        this.finalize(processId, "unknown", state.exit_code, state.signal, "interactive_output_drain_unconfirmed");
        return;
      }
      const settled = state.exit_code === null ? await manager.waitForExitStatus(record.backend_ref) : state;
      if (!settled.exists) {
        this.finalize(processId, "unknown", null, null, "interactive_exit_status_unavailable");
        return;
      }
      if (settled.reason === "deadline_exceeded") {
        this.finalize(processId, "timed_out", settled.exit_code, settled.signal, "deadline_exceeded", settled.ended_at);
        return;
      }
      if (settled.reason === "cancel_requested") {
        this.finalize(processId, "cancelled", settled.exit_code, settled.signal, "cancel_requested", settled.ended_at);
        return;
      }
      if (settled.reason === "termination_unconfirmed" || (settled.exit_code === null && !(record.backend === "native" && settled.signal))) {
        this.finalize(processId, "unknown", null, settled.signal, "interactive_exit_status_unavailable");
        return;
      }
      this.finalize(
        processId,
        settled.exit_code === 0 ? "succeeded" : "failed",
        settled.exit_code,
        settled.signal,
        settled.exit_code === 0 ? null : "nonzero_exit",
        settled.ended_at,
      );
    }
  }

  async start(input: ProcessStartToolInput, requestId: string): Promise<Record<string, unknown>> {
    const { interactive, responseBytes, cwd, sessionManager, backend, effectiveMaxOutputBytes } =
      await resolveProcessAdmission(this.options, input, (targetId) => this.reconcileInteractiveProcesses(targetId));
    const resolution = this.options.operations.resolve(input.idempotency_key, "process_start", input, input.target_id);
    if (resolution.kind !== "new") {
      const existing = this.options.processes.getByKey(input.idempotency_key);
      if (!existing) {
        if (resolution.kind === "replay" && resolution.error) throw resolution.error;
        if (resolution.kind === "unknown") return { state: "unknown", reason: "process_record_missing", native_execution: true, sandboxed: false };
        throw new HostSpanError("PROCESS_UNKNOWN", "Durable operation exists but its process record is missing.");
      }
      if (resolution.kind === "unknown" || existing.state === "unknown") {
        return this.snapshot(existing.process_id, 0, 0, responseBytes);
      }
      if (existing.backend === "pty" || existing.backend_ref) {
        await this.syncSessionState(existing.process_id);
      } else {
        await this.waitForTerminal(existing.process_id, input.wait_ms);
      }
      return this.snapshot(existing.process_id, 0, 0, responseBytes);
    }

    const processId = `proc_${uuidv7().replaceAll("-", "")}`;
    const session = sessionManager?.sessionName(processId) ?? null;
    const deadlineAt = input.deadline_ms === undefined ? null : new Date(Date.now() + input.deadline_ms).toISOString();
    try {
      this.options.processes.create({
        process_id: processId,
        idempotency_key: input.idempotency_key,
        target_id: input.target_id,
        argv_digest: digestArgv(input.argv),
        cwd_relative: cwd.relative,
        backend,
        backend_ref: session,
        deadline_at: deadlineAt,
        max_output_bytes: effectiveMaxOutputBytes,
      });
    } catch (error) {
      this.options.operations.setState(input.idempotency_key, "failed", undefined, error);
      throw error;
    }
    this.options.operations.setState(input.idempotency_key, "launching", {
      state: "launching", process_id: processId, ...(interactive ? { backend } : {}),
    });
    this.options.logger?.info("process.launching", {
      request_id: requestId,
      process_id: processId,
      target_id: input.target_id,
      argv_digest: digestArgv(input.argv),
      cwd: cwd.relative,
      ...(interactive ? { backend } : {}),
    });

    if (sessionManager && session) {
      return launchWorkerBackedProcess({
        options: this.options, input, requestId, processId, session, sessionManager,
        backend, cwd, effectiveMaxOutputBytes, deadlineAt, responseBytes,
        expiresAt: () => this.expiresAt(),
        finalize: (id, state, code, signal, reason, endedAt) => this.finalize(id, state, code, signal, reason, endedAt),
        snapshot: (id, stdout, stderr, bytes) => this.snapshot(id, stdout, stderr, bytes),
        syncSessionState: (id) => this.syncSessionState(id),
      });
    }

    return launchDirectNativeProcess({
      options: this.options, input, requestId, processId, cwd, effectiveMaxOutputBytes,
      deadlineAt, responseBytes, runtimes: this.runtimes,
      expiresAt: () => this.expiresAt(),
      finalize: (id, state, code, signal, reason) => this.finalize(id, state, code, signal, reason),
      terminate: (id, state, reason, grace) => this.terminate(id, state, reason, grace),
      waitForTerminal: (id, wait) => this.waitForTerminal(id, wait),
      snapshot: (id, stdout, stderr, bytes) => this.snapshot(id, stdout, stderr, bytes),
    });
  }

  async poll(input: ProcessPollToolInput): Promise<Record<string, unknown>> {
    const record = this.options.processes.get(input.process_id);
    if (!record) throw new HostSpanError("PROCESS_NOT_FOUND", `Unknown process_id: ${input.process_id}`);
    if (record.backend === "pty" || record.backend_ref) {
      const manager = this.sessionManager(record);
      if (!manager || !record.backend_ref) throw new HostSpanError("PROCESS_UNKNOWN", "Process session backend is unavailable.");
      const current = this.snapshot(input.process_id, input.stdout_cursor, input.stderr_cursor, input.max_bytes);
      if (!TERMINAL_STATES.has(record.state) && Number(current.next_stdout_cursor) <= input.stdout_cursor && Number(current.next_stderr_cursor) <= input.stderr_cursor) {
        const previousBytes = manager.outputBytes(input.process_id) + (record.backend === "native" ? manager.outputBytes(input.process_id, "stderr") : 0);
        await manager.waitForActivity(record.backend_ref, input.process_id, previousBytes, input.wait_ms);
      }
      await this.syncSessionState(input.process_id);
    } else {
      const current = this.snapshot(input.process_id, input.stdout_cursor, input.stderr_cursor, input.max_bytes);
      if (TERMINAL_STATES.has(record.state) || Number(current.next_stdout_cursor) > input.stdout_cursor || Number(current.next_stderr_cursor) > input.stderr_cursor) {
        return current;
      }
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
      const observing = this.writeInflight.get(input.idempotency_key);
      if (observing) return observing;
      if (resolution.error) throw resolution.error;
      const saved = resolution.result as Record<string, unknown> | null;
      if (saved && "next_stdout_cursor" in saved) return saved;
      // A delivery receipt survives observation failure and daemon restart.
      // Reconstruct only the observation; never send the input again.
      try {
        await this.syncSessionState(input.process_id);
        return {
          ...this.snapshot(input.process_id, input.stdout_cursor, 0, input.max_bytes),
          ...(saved?.input_delivered === true ? { input_delivered: true } : {}),
        };
      } catch (error) {
        throw saved?.input_delivered === true ? writeObservationError(error, input) : error;
      }
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
    let previousBytes: number;
    try {
      if (!this.options.terminal) throw new HostSpanError("TERMINAL_BACKEND_UNAVAILABLE", "PTY terminal backend is unavailable.", true);
      await this.syncSessionState(input.process_id);
      const refreshed = this.options.processes.get(input.process_id);
      if (!refreshed || TERMINAL_STATES.has(refreshed.state)) {
        const result = this.snapshot(input.process_id, input.stdout_cursor, 0, input.max_bytes);
        this.options.operations.setState(input.idempotency_key, "succeeded", result);
        return result;
      }
      previousBytes = this.options.terminal.outputBytes(input.process_id);
      if (input.stdout_cursor > previousBytes) {
        throw new HostSpanError("CURSOR_EXPIRED", "Requested process output cursor is beyond the available output.", false, {
          stream: "stdout",
          latest_cursor: previousBytes,
        });
      }
    } catch (error) {
      this.options.operations.setState(input.idempotency_key, "failed", { process_id: input.process_id, input_delivered: false }, error);
      throw error;
    }
    this.options.operations.setState(input.idempotency_key, "running", { state: "writing", process_id: input.process_id });
    try {
      await this.options.terminal.write(session, {
        chars: input.chars,
        control_keys: input.control_keys,
        ...(input.columns !== undefined ? { columns: input.columns } : {}),
        ...(input.rows !== undefined ? { rows: input.rows } : {}),
      });
      // ACK proves delivery to the PTY, not application execution success.
      // Persist that fact before any output wait, read, or decoding can fail.
      this.options.operations.setState(input.idempotency_key, "succeeded", {
        process_id: input.process_id,
        input_delivered: true,
      });
    } catch (error) {
      this.options.operations.setState(input.idempotency_key, "unknown", {
        state: "unknown",
        process_id: input.process_id,
        reason: "interactive_write_outcome_unknown",
      }, error);
      throw new HostSpanError("PROCESS_UNKNOWN", "Interactive input outcome could not be proven; it was not replayed.", false, {
        process_id: input.process_id,
        idempotency_key: input.idempotency_key,
      });
    }
    try {
      await this.options.terminal.waitForActivity(session, input.process_id, previousBytes, input.wait_ms);
      await this.syncSessionState(input.process_id);
      const result = { ...this.snapshot(input.process_id, input.stdout_cursor, 0, input.max_bytes), input_delivered: true };
      this.options.operations.setState(input.idempotency_key, "succeeded", result);
      return result;
    } catch (error) {
      throw writeObservationError(error, input);
    }
  }

  async cancel(input: ProcessCancelToolInput): Promise<Record<string, unknown>> {
    const record = this.options.processes.get(input.process_id);
    if (!record) throw new HostSpanError("PROCESS_NOT_FOUND", `Unknown process_id: ${input.process_id}`);
    const resolution = this.options.operations.resolve(input.idempotency_key, "process_cancel", input, record.target_id);
    if (resolution.kind === "replay") {
      const observing = this.cancelInflight.get(input.idempotency_key);
      if (observing) return observing;
      if (resolution.error) throw resolution.error;
      const saved = resolution.result as Record<string, unknown> | null;
      return saved && "next_stdout_cursor" in saved ? saved : this.snapshot(input.process_id, 0, 0, 131_072);
    }
    if (resolution.kind === "unknown") {
      return (resolution.result as Record<string, unknown> | null) ?? { state: "unknown", process_id: input.process_id };
    }
    if (resolution.kind === "join") {
      const joined = this.cancelInflight.get(input.idempotency_key);
      if (joined) return joined;
      const result = { state: "unknown", process_id: input.process_id, reason: "cancel_restart_boundary" };
      this.options.operations.setState(input.idempotency_key, "unknown", result);
      return result;
    }
    const operation = this.performCancel(input, record);
    this.cancelInflight.set(input.idempotency_key, operation);
    try {
      return await operation;
    } finally {
      this.cancelInflight.delete(input.idempotency_key);
    }
  }

  private async performCancel(input: ProcessCancelToolInput, record: ProcessRecord): Promise<Record<string, unknown>> {
    let state: ProcessState;
    try {
      state = await this.cancelProcess(input, record);
    } catch (error) {
      const current = this.options.processes.get(input.process_id);
      // Final output reads can fail after termination has already been confirmed.
      const settled = current && TERMINAL_STATES.has(current.state) && current.state !== "unknown" && current.state !== "orphaned";
      this.options.operations.setState(input.idempotency_key, settled ? "succeeded" : "unknown", {
        state: settled ? current.state : "unknown",
        process_id: input.process_id,
      });
      throw error;
    }
    const operationState = state === "unknown" || state === "orphaned" ? "unknown" : "succeeded";
    this.options.operations.setState(input.idempotency_key, operationState, { state, process_id: input.process_id });
    const result = this.snapshot(input.process_id, 0, 0, 131_072);
    this.options.operations.setState(input.idempotency_key, operationState, result);
    return result;
  }

  private async cancelProcess(input: ProcessCancelToolInput, record: ProcessRecord): Promise<ProcessState> {
    if (record.state === "orphaned" && processGroupAlive(record.pgid)) {
      safeKillGroup(record.pgid, "SIGTERM");
      let gone = record.pgid ? await waitForGroupGone(record.pgid, input.grace_ms) : true;
      if (!gone) {
        safeKillGroup(record.pgid, "SIGKILL");
        gone = record.pgid ? await waitForGroupGone(record.pgid, 1_000) : true;
      }
      const state: ProcessState = gone ? "cancelled" : "orphaned";
      this.options.processes.markTerminal(record.process_id, state, record.exit_code, record.term_signal, gone ? "cancel_requested_after_recovery" : "orphaned_process_group_still_alive", this.expiresAt());
      return state;
    }
    if (TERMINAL_STATES.has(record.state)) return record.state;
    this.options.operations.setState(input.idempotency_key, "running", { state: "cancelling", process_id: input.process_id });
    return record.backend === "pty" || record.backend_ref
      ? this.terminateSession(input.process_id, "cancelled", "cancel_requested", input.grace_ms)
      : this.terminate(input.process_id, "cancelled", "cancel_requested", input.grace_ms);
  }

  async shutdown(): Promise<void> {
    const active = this.options.processes.active().filter((record) => record.backend === "native" && !record.backend_ref);
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
    await Promise.allSettled([...this.terminationInflight.values(), ...this.writeInflight.values(), ...this.cancelInflight.values()]);
    if (this.runtimes.size > 0) {
      throw new Error(
        `Cannot close HostSpan runtime while ${this.runtimes.size} native process runtime(s) are still active; shut down the supervisor first.`,
      );
    }
  }
}
