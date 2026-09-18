import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { TerminalConfig } from "../config/schema.js";
import { HostSpanError } from "../mcp/errors.js";

const execFileAsync = promisify(execFile);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function envName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export interface TmuxTerminalSnapshot {
  exists: boolean;
  dead: boolean;
  exit_code: number | null;
  pid: number | null;
  columns: number | null;
  rows: number | null;
}

export interface StartTmuxTerminalInput {
  processId: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  columns: number;
  rows: number;
  maxOutputBytes: number;
}

export class TmuxTerminalManager {
  readonly socketPath: string;

  constructor(
    private readonly dataDir: string,
    private readonly config: TerminalConfig,
  ) {
    this.socketPath = join(dataDir, "tmux", "hostspan.sock");
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
  }

  sessionName(processId: string): string {
    return `hs-${processId.replace(/^proc_/, "")}`;
  }

  humanAttachCommand(session: string, readOnly = false): string {
    return `tmux -S ${shellQuote(this.socketPath)} attach-session ${readOnly ? "-r " : ""}-t ${shellQuote(session)}`;
  }

  attachArgs(session: string, readOnly = false): string[] {
    return ["-S", this.socketPath, "attach-session", ...(readOnly ? ["-r"] : []), "-t", session];
  }

  async available(): Promise<boolean> {
    try {
      await execFileAsync("tmux", ["-V"], { encoding: "utf8", timeout: 2_000 });
      return true;
    } catch {
      return false;
    }
  }

  async start(input: StartTmuxTerminalInput): Promise<{ session: string; pid: number | null }> {
    if (!(await this.available())) {
      throw new HostSpanError("TERMINAL_BACKEND_UNAVAILABLE", "tmux is required for interactive terminal sessions.", true);
    }
    const session = this.sessionName(input.processId);
    const spoolPath = this.outputPath(input.processId);
    mkdirSync(dirname(spoolPath), { recursive: true, mode: 0o700 });
    writeFileSync(spoolPath, "", { mode: 0o600 });

    const envPrefix = Object.entries(input.env)
      .map(([key, value]) => {
        if (!envName(key)) throw new HostSpanError("SCOPE_DENIED", `Invalid terminal environment variable name: ${key}`);
        return `${key}=${shellQuote(value)}`;
      })
      .join(" ");
    const command = input.argv.map(shellQuote).join(" ");
    const launch = `sleep 0.10; exec ${envPrefix ? `${envPrefix} ` : ""}${command}`;

    try {
      await this.tmux([
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        String(input.columns),
        "-y",
        String(input.rows),
        "-c",
        input.cwd,
        launch,
      ]);
      await this.tmux(["set-window-option", "-t", `${session}:0`, "remain-on-exit", "on"]);
      await this.tmux(["set-window-option", "-t", `${session}:0`, "history-limit", String(this.config.history_limit_lines)]);
      const pipeCommand = `head -c ${Math.min(input.maxOutputBytes, this.config.max_output_bytes)} >> ${shellQuote(spoolPath)}`;
      await this.tmux(["pipe-pane", "-O", "-t", `${session}:0.0`, pipeCommand]);
    } catch (error) {
      await this.close(session).catch(() => undefined);
      throw new HostSpanError(
        "TERMINAL_BACKEND_UNAVAILABLE",
        `tmux terminal start failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    const state = await this.inspect(session);
    return { session, pid: state.pid };
  }

  async inspect(session: string): Promise<TmuxTerminalSnapshot> {
    try {
      const { stdout } = await this.tmux([
        "list-panes",
        "-t",
        `${session}:0.0`,
        "-F",
        "#{pane_dead}|#{pane_dead_status}|#{pane_pid}|#{pane_width}|#{pane_height}",
      ]);
      const [deadRaw, exitRaw, pidRaw, colsRaw, rowsRaw] = stdout.trim().split("|");
      return {
        exists: true,
        dead: deadRaw === "1",
        exit_code: deadRaw === "1" && exitRaw !== "" ? Number(exitRaw) : null,
        pid: pidRaw ? Number(pidRaw) : null,
        columns: colsRaw ? Number(colsRaw) : null,
        rows: rowsRaw ? Number(rowsRaw) : null,
      };
    } catch {
      return { exists: false, dead: false, exit_code: null, pid: null, columns: null, rows: null };
    }
  }

  inspectSync(session: string): TmuxTerminalSnapshot {
    const result = spawnSync(
      "tmux",
      ["-S", this.socketPath, "list-panes", "-t", `${session}:0.0`, "-F", "#{pane_dead}|#{pane_dead_status}|#{pane_pid}|#{pane_width}|#{pane_height}"],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    if (result.status !== 0) return { exists: false, dead: false, exit_code: null, pid: null, columns: null, rows: null };
    const [deadRaw, exitRaw, pidRaw, colsRaw, rowsRaw] = result.stdout.trim().split("|");
    return {
      exists: true,
      dead: deadRaw === "1",
      exit_code: deadRaw === "1" && exitRaw !== "" ? Number(exitRaw) : null,
      pid: pidRaw ? Number(pidRaw) : null,
      columns: colsRaw ? Number(colsRaw) : null,
      rows: rowsRaw ? Number(rowsRaw) : null,
    };
  }

  async write(
    session: string,
    input: { chars: string; control_keys: string[]; columns?: number; rows?: number },
  ): Promise<void> {
    const state = await this.inspect(session);
    if (!state.exists) throw new HostSpanError("PROCESS_UNKNOWN", `tmux session no longer exists: ${session}`);
    if (state.dead) throw new HostSpanError("TERMINAL_NOT_INTERACTIVE", "Interactive process has already exited.");

    if (input.columns !== undefined || input.rows !== undefined) {
      const columns = input.columns ?? state.columns ?? 120;
      const rows = input.rows ?? state.rows ?? 40;
      await this.tmux(["resize-window", "-t", `${session}:0`, "-x", String(columns), "-y", String(rows)]);
    }
    if (input.chars) await this.tmux(["send-keys", "-l", "-t", `${session}:0.0`, "--", input.chars]);
    for (const key of input.control_keys) await this.tmux(["send-keys", "-t", `${session}:0.0`, key]);
  }

  async close(session: string): Promise<void> {
    try {
      await this.tmux(["kill-session", "-t", session]);
    } catch {
      // Idempotent close: a missing tmux session is already closed.
    }
  }

  closeSync(session: string): void {
    spawnSync("tmux", ["-S", this.socketPath, "kill-session", "-t", session], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
  }

  outputBytes(processId: string): number {
    const path = this.outputPath(processId);
    return existsSync(path) ? statSync(path).size : 0;
  }

  async waitForActivity(session: string, processId: string, previousBytes: number, waitMs: number): Promise<TmuxTerminalSnapshot> {
    const deadline = Date.now() + Math.max(0, waitMs);
    let state = await this.inspect(session);
    while (waitMs > 0 && state.exists && !state.dead && this.outputBytes(processId) === previousBytes && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      state = await this.inspect(session);
    }
    return state;
  }

  private outputPath(processId: string): string {
    return join(this.dataDir, "spools", "processes", processId, "stdout.bin");
  }

  private tmux(args: string[]) {
    return execFileAsync("tmux", ["-S", this.socketPath, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
  }
}
