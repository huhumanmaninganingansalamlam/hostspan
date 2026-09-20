import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TerminalConfig } from "../config/schema.js";
import { HostSpanError } from "../mcp/errors.js";
import type {
  InteractiveOutputDrainResult,
  InteractiveSessionManager,
  InteractiveSessionSnapshot,
  StartInteractiveSessionInput,
} from "./interactive-session.js";
import { ptySocketPath } from "./pty-ipc.js";

interface WorkerStatus {
  schema_version: 1;
  process_id: string;
  session: string;
  worker_pid: number;
  pty_pid: number | null;
  status: "starting" | "running" | "exited" | "failed";
  exit_code: number | null;
  signal: string | null;
  reason: string | null;
  columns: number;
  rows: number;
  output_bytes: number;
  ipc_token: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleepSync(ms: number): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleeper, 0, 0, ms);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class PtySessionManager implements InteractiveSessionManager {
  readonly backend = "pty" as const;
  private readonly workerPath = fileURLToPath(new URL("./pty-worker.mjs", import.meta.url));

  constructor(
    private readonly dataDir: string,
    private readonly config: TerminalConfig,
  ) {
    mkdirSync(join(dataDir, "sessions"), { recursive: true, mode: 0o700 });
  }

  sessionName(processId: string): string {
    return processId;
  }

  humanAttachCommand(session: string, readOnly = false): string {
    return `hostspan terminal attach --process ${shellQuote(session)}${readOnly ? " --read-only" : ""}`;
  }

  async available(): Promise<boolean> {
    if (!(["linux", "darwin", "win32"] as NodeJS.Platform[]).includes(process.platform)) return false;
    try {
      await import("node-pty");
      return existsSync(this.workerPath);
    } catch {
      return false;
    }
  }

  async start(input: StartInteractiveSessionInput): Promise<{ session: string; pid: number | null }> {
    if (!(await this.available())) {
      throw new HostSpanError("TERMINAL_BACKEND_UNAVAILABLE", "HostSpan PTY runtime is unavailable on this platform.", true);
    }
    for (const key of Object.keys(input.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new HostSpanError("SCOPE_DENIED", `Invalid terminal environment variable name: ${key}`);
    }
    const session = this.sessionName(input.processId);
    const sessionDir = this.sessionDir(session);
    rmSync(sessionDir, { recursive: true, force: true });
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const specPath = join(sessionDir, `launch-${process.pid}.json`);
    const ipcToken = randomBytes(32).toString("base64url");
    writeFileSync(
      specPath,
      `${JSON.stringify({
        dataDir: this.dataDir,
        session,
        processId: input.processId,
        cwd: input.cwd,
        argv: input.argv,
        env: input.env,
        columns: input.columns,
        rows: input.rows,
        deadlineAt: input.deadlineAt,
        attachHistoryBytes: this.config.attach_history_bytes,
        socketPath: this.socketPath(session),
        ipcToken,
        maxOutputBytes: Math.min(input.maxOutputBytes, this.config.max_output_bytes),
      })}\n`,
      { mode: 0o600 },
    );
    chmodSync(specPath, 0o600);
    const child = spawn(process.execPath, [this.workerPath, "--spec", specPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
    });
    child.unref();
    const deadline = Date.now() + (process.platform === "win32" ? 10_000 : 5_000);
    while (Date.now() <= deadline) {
      const status = this.readStatus(session);
      if (status?.status === "running") return { session, pid: status.pty_pid };
      if (status?.status === "exited") return { session, pid: status.pty_pid };
      if (status?.status === "failed") {
        throw new HostSpanError("TERMINAL_BACKEND_UNAVAILABLE", status.reason ?? "PTY worker failed to start.", true);
      }
      await sleep(25);
    }
    throw new HostSpanError("TERMINAL_BACKEND_UNAVAILABLE", "PTY worker did not become ready.", true);
  }

  async inspect(session: string): Promise<InteractiveSessionSnapshot> {
    return this.inspectSync(session);
  }

  inspectSync(session: string): InteractiveSessionSnapshot {
    let status = this.readStatus(session);
    if (!status) return this.missingSnapshot();
    if (status.status === "exited" || status.status === "failed") {
      return {
        exists: true,
        dead: true,
        exit_code: status.exit_code,
        signal: status.signal,
        reason: status.reason,
        pid: status.pty_pid,
        columns: status.columns,
        rows: status.rows,
      };
    }
    if (!processAlive(status.worker_pid)) {
      // The worker writes its terminal status immediately before exiting.
      // A concurrent Windows reader can still observe the previous "running"
      // replacement while the worker PID has already disappeared. Give the
      // final durable status a short settling window before declaring the
      // session missing; otherwise a successful cancel can become UNKNOWN.
      const deadline = Date.now() + (process.platform === "win32" ? 500 : 100);
      while (Date.now() <= deadline) {
        sleepSync(10);
        const settled = this.readStatus(session);
        if (settled?.status === "exited" || settled?.status === "failed") {
          status = settled;
          return {
            exists: true,
            dead: true,
            exit_code: status.exit_code,
            signal: status.signal,
            reason: status.reason,
            pid: status.pty_pid,
            columns: status.columns,
            rows: status.rows,
          };
        }
      }
      return this.missingSnapshot();
    }
    return {
      exists: true,
      dead: false,
      exit_code: null,
      signal: null,
      reason: null,
      pid: status.pty_pid,
      columns: status.columns,
      rows: status.rows,
    };
  }

  async write(
    session: string,
    input: { chars: string; control_keys: string[]; columns?: number; rows?: number },
  ): Promise<void> {
    const state = this.inspectSync(session);
    if (!state.exists) throw new HostSpanError("PROCESS_UNKNOWN", `PTY session worker no longer exists: ${session}`);
    if (state.dead) throw new HostSpanError("TERMINAL_NOT_INTERACTIVE", "Interactive process has already exited.");
    await this.request(session, { op: "write", ...input });
  }

  async close(session: string, graceMs = 500): Promise<void> {
    const state = this.inspectSync(session);
    if (!state.exists || state.dead) return;
    await this.request(session, { op: "terminate", reason: "cancel_requested", grace_ms: graceMs });
    await this.waitForExitStatus(session, graceMs + 1_500);
  }

  closeSync(session: string): void {
    const status = this.readStatus(session);
    if (!status || status.status === "exited" || status.status === "failed") return;
    const pid = status.pty_pid;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }

  outputBytes(processId: string): number {
    const path = this.outputPath(processId);
    return existsSync(path) ? statSync(path).size : 0;
  }

  async waitForOutputDrain(processId: string, waitMs = 1_500): Promise<InteractiveOutputDrainResult> {
    const drainPath = this.drainPath(processId);
    const deadline = Date.now() + Math.max(0, waitMs);
    while (Date.now() <= deadline) {
      if (existsSync(drainPath)) return { drained: true, bytes: this.outputBytes(processId) };
      await sleep(25);
    }
    return { drained: existsSync(drainPath), bytes: this.outputBytes(processId) };
  }

  async waitForExitStatus(session: string, waitMs = 1_500): Promise<InteractiveSessionSnapshot> {
    const deadline = Date.now() + Math.max(0, waitMs);
    let state = this.inspectSync(session);
    while (Date.now() <= deadline) {
      if (state.exists && state.dead) return state;
      await sleep(25);
      state = this.inspectSync(session);
    }
    return state;
  }

  async waitForActivity(session: string, processId: string, previousBytes: number, waitMs: number): Promise<InteractiveSessionSnapshot> {
    const deadline = Date.now() + Math.max(0, waitMs);
    let state = this.inspectSync(session);
    while (waitMs > 0 && state.exists && !state.dead && this.outputBytes(processId) === previousBytes && Date.now() < deadline) {
      await sleep(25);
      state = this.inspectSync(session);
    }
    return state;
  }

  async attach(session: string, readOnly = false): Promise<void> {
    const state = this.inspectSync(session);
    if (!state.exists) throw new Error(`PTY session is no longer available: ${session}`);
    if (state.dead) throw new Error(`PTY session has already exited: ${session}`);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.socketPath(session));
      let acknowledged = false;
      let header = Buffer.alloc(0);
      const cleanup = () => {
        process.off("SIGWINCH", resize);
        process.off("SIGTERM", close);
        process.off("SIGINT", close);
        if (process.stdin.isTTY && !readOnly) process.stdin.setRawMode(false);
        process.stdin.pause();
      };
      const close = () => socket.destroy();
      const resize = () => {
        if (!process.stdout.isTTY) return;
        void this.write(session, {
          chars: "",
          control_keys: [],
          columns: process.stdout.columns,
          rows: process.stdout.rows,
        }).catch(() => undefined);
      };
      socket.once("connect", () => {
        const status = this.readStatus(session);
        if (!status?.ipc_token) {
          socket.destroy();
          reject(new Error("PTY session authentication state is unavailable"));
          return;
        }
        socket.write(`${JSON.stringify({ op: "attach", read_only: readOnly, token: status.ipc_token })}\n`);
      });
      socket.on("data", (chunk) => {
        if (!acknowledged) {
          header = Buffer.concat([header, chunk]);
          const newline = header.indexOf(10);
          if (newline < 0) return;
          const response = JSON.parse(header.subarray(0, newline).toString("utf8")) as { ok: boolean; error?: string };
          if (!response.ok) {
            socket.destroy();
            reject(new Error(response.error ?? "attach failed"));
            return;
          }
          acknowledged = true;
          const rest = header.subarray(newline + 1);
          if (rest.length) process.stdout.write(rest);
          process.stderr.write(`HostSpan terminal attached (${readOnly ? "read-only" : "writable"}). ${readOnly ? "Ctrl+C" : "Ctrl+]"} detaches.\n`);
          process.on("SIGWINCH", resize);
          process.on("SIGTERM", close);
          process.on("SIGINT", close);
          if (!readOnly) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on("data", onInput);
          }
          resize();
          return;
        }
        process.stdout.write(chunk);
      });
      const onInput = (chunk: Buffer) => {
        if (chunk.length === 1 && chunk[0] === 0x1d) {
          socket.destroy();
          return;
        }
        socket.write(chunk);
      };
      socket.once("error", (error) => {
        cleanup();
        reject(error);
      });
      socket.once("close", () => {
        process.stdin.off("data", onInput);
        cleanup();
        resolve();
      });
    });
  }

  private request(session: string, payload: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const status = this.readStatus(session);
      if (!status?.ipc_token) {
        reject(new Error("PTY session authentication state is unavailable"));
        return;
      }
      const socket = createConnection(this.socketPath(session));
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("PTY worker request timed out"));
      }, 5_000);
      timer.unref();
      socket.once("connect", () => socket.write(`${JSON.stringify({ ...payload, token: status.ipc_token })}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        const response = JSON.parse(buffer.slice(0, newline)) as { ok: boolean; error?: string };
        socket.end();
        if (response.ok) resolve();
        else reject(new Error(response.error ?? "PTY worker request failed"));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private readStatus(session: string): WorkerStatus | undefined {
    const path = this.statusPath(session);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (existsSync(path)) {
        try {
          return JSON.parse(readFileSync(path, "utf8")) as WorkerStatus;
        } catch {
          // An atomic replacement can be briefly unavailable to a concurrent
          // Windows reader. Recheck before declaring the durable session lost.
        }
      }
      if (attempt < 4) sleepSync(5);
    }
    return undefined;
  }

  private missingSnapshot(): InteractiveSessionSnapshot {
    return { exists: false, dead: false, exit_code: null, signal: null, reason: null, pid: null, columns: null, rows: null };
  }

  private sessionDir(session: string): string {
    return join(this.dataDir, "sessions", session);
  }

  private socketPath(session: string): string {
    return ptySocketPath(this.dataDir, session);
  }

  private statusPath(session: string): string {
    return join(this.sessionDir(session), "status.json");
  }

  private drainPath(processId: string): string {
    return join(this.sessionDir(this.sessionName(processId)), "output-drained");
  }

  private outputPath(processId: string): string {
    return join(this.dataDir, "spools", "processes", processId, "stdout.bin");
  }
}
