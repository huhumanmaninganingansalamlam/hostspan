import { ComputerInputSchema, type ComputerInput } from "./input-schema.js";
export { ComputerInputSchema } from "./input-schema.js";
export type { ComputerInput } from "./input-schema.js";
import { buildDesktopStatus } from "./session-state.js";
import { parseDesktopWorkerReply, mapDesktopWorkerError, parseDesktopWorkerCommand, type PendingDesktopRequest, type DesktopWorkerResult } from "./worker-protocol.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { HostSpanError } from "../errors.js";
import type { OperationsStore } from "../operations/store.js";

export function desktopBackend(): "wayland-portal" | "native" {
  return process.platform === "darwin" || process.platform === "win32" ? "native" : "wayland-portal";
}

export function supportedDesktopSession(): boolean {
  return desktopBackend() === "native" || process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland";
}

/** One interactive desktop has one pointer/focus; requests never overlap. */
export class PortalDesktop {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<string, PendingDesktopRequest>();
  private observing: Promise<DesktopWorkerResult> | undefined;
  private sessionId: string | undefined;
  private observationId: string | undefined;
  private pipewireNodeId: number | undefined;
  private size: { width: number; height: number } | undefined;
  private opening: Promise<DesktopWorkerResult> | undefined;
  private openError: Error | undefined;
  private captureError: Error | undefined;
  private busy = false;
  private displayId: string | undefined;
  private permission: "screen_recording" | "accessibility" | undefined;
  private sessionCreatedAt: string | undefined;
  private activity: "viewing" | "controlling" | undefined;

  constructor(private readonly operations: OperationsStore, private readonly backend = desktopBackend()) {}

  private desktopTarget(): Record<string, unknown> {
    // The portal selects a monitor, not an application window or filesystem target.
    return { desktop_backend: this.backend === "native" ? process.platform === "darwin" ? "macos-native" : "windows-native" : "wayland-portal",
      desktop_scope: "monitor", window_attribution: "unavailable",
      ...(this.displayId ? { display_id: this.displayId } : {}),
      ...(this.pipewireNodeId === undefined ? {} : { pipewire_node_id: this.pipewireNodeId }),
      ...(this.size ? { coordinate_width: this.size.width, coordinate_height: this.size.height } : {}) };
  }

  status(): Record<string, unknown> {
    return buildDesktopStatus({
      backend: this.backend,
      sessionId: this.sessionId,
      sessionCreatedAt: this.sessionCreatedAt,
      observationId: this.observationId,
      workerPid: this.child?.pid,
      permission: this.permission,
      openError: this.openError,
      captureError: this.captureError,
      opening: Boolean(this.opening),
      hasPending: this.pending.size > 0,
      observing: Boolean(this.observing),
      activity: this.activity,
    }, this.desktopTarget());
  }

  private start(): void {
    if (this.child) return;
    if (this.backend === "wayland-portal" && (process.platform !== "linux" || process.env.XDG_SESSION_TYPE !== "wayland")) {
      throw new HostSpanError("POLICY_UNENFORCEABLE", "This desktop backend requires a logged-in Linux Wayland session.");
    }
    const asset = this.backend === "wayland-portal" ? "portal-worker.py"
      : process.platform === "darwin" ? "native-macos" : "native-windows.ps1";
    const helper = fileURLToPath(new URL(`./${asset}`, import.meta.url)).replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
    if (this.backend === "native" && !["darwin", "win32"].includes(process.platform)) {
      throw new HostSpanError("POLICY_UNENFORCEABLE", "Native desktop control requires macOS or Windows.");
    }
    if (this.backend === "native" && !existsSync(helper)) {
      throw new HostSpanError("TARGET_NOT_READY", "Native desktop helper is missing. Use the matching HostSpan desktop package.");
    }
    const executable = this.backend === "wayland-portal" ? "/usr/bin/python3" : process.platform === "darwin" ? helper : "powershell.exe";
    const args = this.backend === "wayland-portal" ? ["-I", helper]
      : process.platform === "darwin" ? [] : ["-NoProfile", "-Sta", "-File", helper];
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let buffered = "";
    child.stdout.setEncoding("utf8");
    // stderr may include display/driver details. Never forward it to an MCP caller or audit log.
    child.stderr.resume();
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      buffered += chunk;
      if (buffered.length > 24 * 1024 * 1024) {
        this.fail(new Error("Desktop worker response exceeds 24 MiB"));
        return;
      }
      while (buffered.includes("\n")) {
        const end = buffered.indexOf("\n");
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        try {
          const reply = parseDesktopWorkerReply(line);
          if (reply.kind === "permission_required") {
            this.permission = reply.permission;
            continue;
          }
          if (reply.kind === "closed") {
            this.fail(new Error("Desktop sharing ended. Open computer again to select a screen."));
            return;
          }
          const pending = this.pending.get(reply.id);
          if (!pending) throw new Error("Unexpected desktop worker reply");
          this.pending.delete(reply.id);
          if (reply.kind === "error") pending.reject(mapDesktopWorkerError(reply));
          else pending.resolve(reply.result);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error("Invalid desktop worker response"));
        }
      }
    });
    child.on("error", (error) => { if (this.child === child) this.fail(error); });
    child.on("exit", () => {
      if (this.child === child) this.fail(new Error("Desktop worker exited; session must be opened again"));
    });
    child.stdin.on("error", (error) => { if (this.child === child) this.fail(error); });
  }

  private fail(error: Error): void {
    const child = this.child;
    this.child = undefined;
    this.openError = error;
    this.captureError = undefined;
    this.sessionId = this.observationId = this.size = this.pipewireNodeId = undefined;
    this.displayId = this.permission = undefined;
    this.sessionCreatedAt = undefined;
    this.opening = undefined;
    this.activity = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.observing = undefined;
    // This process owns only its worker. Disconnecting its D-Bus connection revokes the portal session.
    child?.kill();
  }

  private call(command: ComputerInput | { action: "open" | "observe" | "close" }): Promise<DesktopWorkerResult> {
    this.start();
    const child = this.child;
    if (!child) throw new Error("Desktop worker did not start");
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      // Consent belongs to the live session, not a wall-clock deadline. Caller close,
      // OS response/revocation and worker failure still end it. Observation waiting
      // is bounded separately so a slow frame does not terminate a live session.
      const timer = command.action === "open" || command.action === "observe" ? undefined : setTimeout(() =>
        this.fail(new Error("Desktop worker deadline exceeded; input must not be replayed")), 10_000);
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      const workerCommand = parseDesktopWorkerCommand({ ...command, id });
      child.stdin.write(`${JSON.stringify(workerCommand)}\n`);
    });
  }

  private async observe(): Promise<Record<string, unknown>> {
    // Keep the original reply (including a late result) until an observer consumes
    // it. A retry must not send another capture or overwrite its correlation ID.
    // Starting a fresh capture invalidates the old image even if capture fails.
    this.observationId = undefined;
    const capture = this.observing ?? (() => {
      this.activity = "viewing";
      const pending = this.call({ action: "observe" }).finally(() => {
        if (this.activity === "viewing") this.activity = undefined;
      });
      this.observing = pending;
      return pending;
    })();
    const expired = new HostSpanError("DEADLINE_EXCEEDED", "Screen capture is still processing. Observe this same session again.", true,
      { reason: "desktop_observation_timeout", retry_after_ms: 1000 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: DesktopWorkerResult;
    try {
      frame = await Promise.race([capture, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(expired), 10_000);
      })]);
      this.observing = undefined;
    } catch (error) {
      if (error !== expired) {
        this.observing = undefined;
        this.captureError = error instanceof Error ? error : new Error("Desktop capture failed");
      }
      throw error;
    } finally { clearTimeout(timer); }
    if (typeof frame.image !== "string" || frame.mime_type !== "image/png"
      || typeof frame.coordinate_width !== "number" || typeof frame.coordinate_height !== "number") {
      this.captureError = new Error("Desktop worker returned an invalid observation");
      throw this.captureError;
    }
    this.captureError = undefined;
    this.size = { width: frame.coordinate_width, height: frame.coordinate_height };
    this.observationId = randomUUID();
    return { ...frame, ...this.desktopTarget(), session_id: this.sessionId, observation_id: this.observationId,
      observed_at: new Date().toISOString(), state: "ready",
      message: "Screen captured. Choose an action using this image; verify its result in the next image." };
  }

  async run(raw: unknown): Promise<Record<string, unknown>> {
    const input = ComputerInputSchema.parse(raw);
    if (this.busy) throw new HostSpanError("SERVER_BUSY", "Another desktop observation or action is in progress.", true);
    this.busy = true;
    try {
      if (input.action === "open") {
        if (this.sessionId) return this.status();
        this.openError = undefined;
        this.captureError = undefined;
        const sessionId = randomUUID();
        this.sessionId = sessionId;
        this.sessionCreatedAt = new Date().toISOString();
        try {
          const opening = this.call({ action: "open" });
          this.opening = opening;
          void opening.then((result) => {
            if (this.sessionId !== sessionId) return;
            if (typeof result.pipewire_node_id === "number" && Number.isSafeInteger(result.pipewire_node_id) && result.pipewire_node_id >= 0) this.pipewireNodeId = result.pipewire_node_id;
            if (typeof result.display_id === "string") this.displayId = result.display_id;
            this.permission = undefined;
            this.opening = undefined;
          }, (error: unknown) => {
            if (this.sessionId !== sessionId) return;
            this.fail(error instanceof Error ? error : new Error("Desktop open failed"));
          });
          // Human consent must not occupy a long MCP request.
          return { ...this.status(), observation_required: true };
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error("Desktop open failed"));
          throw error;
        }
      }
      // Resolve existing mutation keys before requiring a live session: reconnect must never replay input.
      if ("idempotency_key" in input && this.operations.getState(input.idempotency_key)) {
        const previous = this.operations.resolve(input.idempotency_key, "computer", input);
        if (previous.kind === "replay") {
          if (previous.error) throw previous.error;
          return { ...(previous.result as Record<string, unknown> | null), replayed: true,
            observation_required: true, message: "This input was already sent. Observe its result; do not send it again.",
            next_action: this.status().next_action };
        }
        return { state: "unknown", replayed: false, dispatched: "unknown", observation_required: true,
          message: "Input delivery is uncertain. Inspect the screen before deciding whether another action is needed; do not resend automatically.",
          next_action: this.status().next_action };
      }
      if (!this.sessionId || input.session_id !== this.sessionId) {
        if (this.openError) throw new HostSpanError(
          this.openError instanceof HostSpanError ? this.openError.code : "INTERNAL_ERROR",
          `Desktop connection failed: ${this.openError.message}. Open computer again to select a screen.`, false,
          { ...(this.openError instanceof HostSpanError ? this.openError.details : {}), next_action: this.status().next_action });
        throw new HostSpanError("SCOPE_DENIED", "Desktop session is not active or belongs to another session. Open computer again.", false, { next_action: this.status().next_action });
      }
      if (input.action === "close") {
        try { if (!this.opening) await this.call({ action: "close" }); }
        finally { this.dispose(); }
        return { closed: true, ...this.status(), message: "Desktop control closed. No further input will be sent." };
      }
      if (this.opening) {
        return { ...this.status(), dispatched: false, observation_required: true };
      }
      if (input.action === "observe") {
        try { return await this.observe(); }
        catch (error) {
          throw new HostSpanError(error instanceof HostSpanError ? error.code : "INTERNAL_ERROR", `Screen capture failed: ${error instanceof Error ? error.message : "unknown error"}`,
            true, { ...(error instanceof HostSpanError ? error.details : {}), next_action: this.status().next_action });
        }
      }
      if (this.observing) {
        throw new HostSpanError("SERVER_BUSY", "A screen capture is still processing. Observe this same session before sending input.", true,
          { reason: "desktop_observation_pending", next_action: this.status().next_action });
      }
      if (input.observation_id !== this.observationId) {
        throw new HostSpanError("STALE_CONTENT", "Observe the desktop again before acting on an outdated observation.", true, { next_action: this.status().next_action });
      }
      if ("x" in input && (!this.size || input.x >= this.size.width || input.y >= this.size.height)) {
        throw new HostSpanError("VALIDATION_FAILED", "Pointer coordinates are outside the selected screen.");
      }
      this.operations.resolve(input.idempotency_key, "computer", input);
      // Commit ambiguity before sending: a crash at any later point cannot cause duplicate input.
      this.operations.setState(input.idempotency_key, "unknown", { dispatched: "unknown" });
      this.observationId = undefined;
      this.activity = "controlling";
      try {
        await this.call(input);
      } catch (error) {
        if (error instanceof HostSpanError && error.code === "TARGET_NOT_READY"
          && error.details.reason === "macos_desktop_locked") {
          this.captureError = error;
          if (error.details.dispatched === false) {
            const rejected = new HostSpanError(error.code, error.message, true,
              { ...error.details, next_action: this.status().next_action });
            this.operations.setState(input.idempotency_key, "failed", undefined, rejected);
            throw rejected;
          }
        }
        return { state: "unknown", dispatched: "unknown", observation_required: true,
          error: error instanceof Error ? error.message : "Desktop input failed",
          message: "Input delivery is uncertain. Inspect the screen; do not resend automatically.",
          next_action: this.status().next_action };
      } finally {
        if (this.activity === "controlling") this.activity = undefined;
      }
      const receipt = { ...this.desktopTarget(), state: "completed", dispatched: true, outcome_verified: false, session_id: this.sessionId,
        ...(input.action === "text" ? { clipboard_modified: true } : {}) };
      this.operations.setState(input.idempotency_key, "completed", receipt);
      try {
        return { ...await this.observe(), ...receipt,
          message: "Input sent. Check the returned image to confirm the intended result.",
          next_action: this.status().next_action };
      } catch (error) {
        return { ...receipt, observation_required: true,
          observation_error: error instanceof Error ? error.message : "Desktop observation failed",
          ...(error instanceof HostSpanError ? { observation_error_details: error.details } : {}),
          message: this.sessionId
            ? "Input was sent, but the screen could not be captured. Retry observation only, not the input."
            : "Input was sent, but desktop sharing ended. Open computer again and observe; do not repeat the input.",
          next_action: this.status().next_action };
      }
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    this.fail(new Error("Desktop session closed"));
    this.openError = undefined;
  }
}
