import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TerminalConfig } from "../config/schema.js";
import { HostSpanError } from "../errors.js";
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
  owner_generation?: number | null;
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
  private ownerGeneration: number | null = null;
  private readonly requireOwnership: boolean;
  private readonly configPath: string | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly config: TerminalConfig,
    options: { requireOwnership?: boolean; configPath?: string } = {},
  ) {
    this.requireOwnership = options.requireOwnership ?? false;
    this.configPath = options.configPath;
  }

  activateOwnership(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error(`invalid PTY runtime generation: ${generation}`);
    const path = this.runtimeOwnerPath();
    const current = this.readRuntimeOwnerGeneration();
    if (current !== null && current > generation) throw new Error(`cannot replace PTY runtime generation ${current} with stale generation ${generation}`);
    mkdirSync(join(this.dataDir, "sessions"), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      writeFileSync(temp, `${JSON.stringify({ schema_version: 1, generation })}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
      chmodSync(path, 0o600);
    } finally {
      rmSync(temp, { force: true });
    }
    this.ownerGeneration = generation;
  }

  currentOwnerGeneration(): number | null {
    return this.readRuntimeOwnerGeneration();
  }

  private mutationGeneration(): number | undefined {
    const current = this.readRuntimeOwnerGeneration();
    if (this.ownerGeneration !== null) {
      if (current !== this.ownerGeneration) {
        throw new HostSpanError("SERVER_BUSY", "PTY runtime ownership changed; reconnect to the active HostSpan daemon.", true, {
          resource: "pty_runtime",
          reason: "stale_runtime_owner",
        });
      }
      return this.ownerGeneration;
    }
    if (this.requireOwnership) {
      throw new HostSpanError("SERVER_BUSY", "PTY runtime ownership is not active yet.", true, {
        resource: "pty_runtime",
        reason: "runtime_ownership_inactive",
      });
    }
    return current ?? undefined;
  }

  sessionName(processId: string): string {
    return processId;
  }

  humanAttachCommand(session: string, readOnly = false): string {
    const config = this.configPath ? ` --config ${shellQuote(this.configPath)}` : "";
    return `hostspan terminal attach --process ${shellQuote(session)}${config}${readOnly ? " --read-only" : ""}`;
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
    const ownerGeneration = this.mutationGeneration();
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
        ...(ownerGeneration === undefined ? {} : { ownerGeneration, ownerPath: this.runtimeOwnerPath() }),
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
      const status = await this.readStatusAsync(session);
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
    const status = await this.readStatusAsync(session);
    if (!status) return this.missingSnapshot();
    if (status.status === "exited" || status.status === "failed") return this.statusSnapshot(status);
    if (processAlive(status.worker_pid)) return this.statusSnapshot(status);

    // Let the worker persist its terminal status without blocking the event loop.
    const deadline = Date.now() + (process.platform === "win32" ? 500 : 100);
    while (Date.now() <= deadline) {
      await sleep(10);
      const settled = this.readStatusOnce(session);
      if (settled?.status === "exited" || settled?.status === "failed") return this.statusSnapshot(settled);
    }
    return this.missingSnapshot();
  }

  inspectSync(session: string): InteractiveSessionSnapshot {
    const status = this.readStatus(session);
    if (!status) return this.missingSnapshot();
    if (status.status === "exited" || status.status === "failed") {
      return this.statusSnapshot(status);
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
          return this.statusSnapshot(settled);
        }
      }
      return this.missingSnapshot();
    }
    return this.statusSnapshot(status);
  }

  async write(
    session: string,
    input: { chars: string; control_keys: string[]; columns?: number; rows?: number },
  ): Promise<void> {
    const state = await this.inspect(session);
    if (!state.exists) throw new HostSpanError("PROCESS_UNKNOWN", `PTY session worker no longer exists: ${session}`);
    if (state.dead) throw new HostSpanError("TERMINAL_NOT_INTERACTIVE", "Interactive process has already exited.");
    await this.request(session, { op: "write", ...input });
  }

  async close(session: string, graceMs = 500): Promise<void> {
    const state = await this.inspect(session);
    if (!state.exists || state.dead) return;
    await this.request(session, { op: "terminate", reason: "cancel_requested", grace_ms: graceMs });
    await this.waitForExitStatus(session, graceMs + 1_500);
  }

  closeSync(session: string): void {
    const status = this.readStatus(session);
    if (!status || status.status === "exited" || status.status === "failed") return;
    this.mutationGeneration();
    const pid = status.pty_pid;
    if (pid) {
      if (process.platform === "win32") {
        const killed = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5_000,
          maxBuffer: 1024 * 1024,
        });
        if (killed.error && (killed.error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw killed.error;
        }
        if (killed.status !== 0 && processAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The pseudoconsole process may already have exited.
          }
        }
      } else {
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
    } else if (processAlive(status.worker_pid)) {
      try {
        process.kill(status.worker_pid, "SIGKILL");
      } catch {
        // The worker may already have exited.
      }
    }

    const deadline = Date.now() + (process.platform === "win32" ? 2_500 : 1_500);
    while (Date.now() <= deadline) {
      const settled = this.readStatus(session);
      if (!settled) return;
      if ((settled.status === "exited" || settled.status === "failed") && this.outputDrained(settled.process_id)) return;
      sleepSync(25);
    }
  }

  outputBytes(processId: string): number {
    const path = this.outputPath(processId);
    return existsSync(path) ? statSync(path).size : 0;
  }

  outputDrained(processId: string): boolean {
    return existsSync(this.drainPath(processId));
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
    let state = await this.inspect(session);
    while (Date.now() <= deadline) {
      if (state.exists && state.dead) return state;
      await sleep(25);
      state = await this.inspect(session);
    }
    return state;
  }

  async waitForActivity(session: string, processId: string, previousBytes: number, waitMs: number): Promise<InteractiveSessionSnapshot> {
    const deadline = Date.now() + Math.max(0, waitMs);
    let state = await this.inspect(session);
    while (waitMs > 0 && state.exists && !state.dead && this.outputBytes(processId) === previousBytes && Date.now() < deadline) {
      await sleep(25);
      state = await this.inspect(session);
    }
    return state;
  }

  async attach(session: string, readOnly = false): Promise<void> {
    const state = await this.inspect(session);
    if (!state.exists) throw new Error(`PTY session is no longer available: ${session}`);
    if (state.dead) throw new Error(`PTY session has already exited: ${session}`);
    const ownerGeneration = readOnly ? undefined : this.mutationGeneration();
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
        if (readOnly || !process.stdout.isTTY) return;
        void this.request(session, {
          chars: "",
          control_keys: [],
          columns: process.stdout.columns,
          rows: process.stdout.rows,
        }, ownerGeneration).catch(() => undefined);
      };
      socket.once("connect", () => {
        void this.readStatusAsync(session).then((status) => {
          if (socket.destroyed) return;
          if (!status?.ipc_token) {
            socket.destroy();
            reject(new Error("PTY session authentication state is unavailable"));
            return;
          }
          socket.write(`${JSON.stringify({ op: "attach", read_only: readOnly, token: status.ipc_token, ...(ownerGeneration === undefined ? {} : { owner_generation: ownerGeneration }) })}\n`);
        }, (error: unknown) => {
          socket.destroy();
          reject(error);
        });
      });
      socket.on("data", (chunk) => {
        if (!acknowledged) {
          header = Buffer.concat([header, chunk]);
          const newline = header.indexOf(10);
          if (newline < 0) return;
          const response = JSON.parse(header.subarray(0, newline).toString("utf8")) as { ok: boolean; error?: string };
          if (!response.ok) {
            socket.destroy();
            reject(response.error === "stale_owner" ? new HostSpanError("SERVER_BUSY", "PTY runtime ownership changed; reconnect to the active HostSpan daemon.", true, { resource: "pty_runtime", reason: "stale_runtime_owner" }) : new Error(response.error ?? "attach failed"));
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

  private async request(session: string, payload: Record<string, unknown>, ownerGeneration = this.mutationGeneration()): Promise<void> {
    const status = await this.readStatusAsync(session);
    if (!status?.ipc_token) throw new Error("PTY session authentication state is unavailable");
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath(session));
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("PTY worker request timed out"));
      }, 5_000);
      timer.unref();
      socket.once("connect", () => socket.write(`${JSON.stringify({ ...payload, token: status.ipc_token, ...(ownerGeneration === undefined ? {} : { owner_generation: ownerGeneration }) })}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        const response = JSON.parse(buffer.slice(0, newline)) as { ok: boolean; error?: string };
        socket.end();
        if (response.ok) resolve();
        else if (response.error === "stale_owner") {
          reject(new HostSpanError("SERVER_BUSY", "PTY runtime ownership changed; reconnect to the active HostSpan daemon.", true, {
            resource: "pty_runtime",
            reason: "stale_runtime_owner",
          }));
        } else reject(new Error(response.error ?? "PTY worker request failed"));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private readStatus(session: string): WorkerStatus | undefined {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const status = this.readStatusOnce(session);
      if (status) return status;
      if (attempt < 4) sleepSync(5);
    }
    return undefined;
  }

  private async readStatusAsync(session: string): Promise<WorkerStatus | undefined> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const status = this.readStatusOnce(session);
      if (status) return status;
      if (attempt < 4) await sleep(5);
    }
    return undefined;
  }

  private readStatusOnce(session: string): WorkerStatus | undefined {
    const path = this.statusPath(session);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as WorkerStatus;
    } catch {
      // An atomic replacement can be briefly unavailable to a concurrent
      // Windows reader. Recheck before declaring the durable session lost.
      return undefined;
    }
  }

  private readRuntimeOwnerGeneration(): number | null {
    const path = this.runtimeOwnerPath();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (existsSync(path)) {
        try {
          const parsed = JSON.parse(readFileSync(path, "utf8")) as { generation?: unknown };
          const generation = Number(parsed.generation);
          return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
        } catch {
          // Atomic replacement can briefly race a Windows reader.
        }
      }
      if (attempt < 4) sleepSync(5);
    }
    return null;
  }

  private runtimeOwnerPath(): string {
    return join(this.dataDir, "sessions", "runtime-owner.json");
  }

  private missingSnapshot(): InteractiveSessionSnapshot {
    return { exists: false, dead: false, exit_code: null, signal: null, reason: null, pid: null, columns: null, rows: null };
  }

  private statusSnapshot(status: WorkerStatus): InteractiveSessionSnapshot {
    const dead = status.status === "exited" || status.status === "failed";
    return {
      exists: true,
      dead,
      exit_code: dead ? status.exit_code : null,
      signal: dead ? status.signal : null,
      reason: dead ? status.reason : null,
      pid: status.pty_pid,
      columns: status.columns,
      rows: status.rows,
    };
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
