import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { HostSpanError } from "../errors.js";
import type { OperationsStore } from "../operations/store.js";

const session = { session_id: z.string().uuid() };
const mutation = {
  ...session,
  observation_id: z.string().uuid(),
  idempotency_key: z.string().min(1).max(128),
};
const pointer = { x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() };
export const ComputerInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open") }).strict(),
  z.object({ action: z.literal("observe"), ...session }).strict(),
  z.object({ action: z.literal("close"), ...session }).strict(),
  z.object({ action: z.literal("move"), ...mutation, ...pointer }).strict(),
  z.object({ action: z.literal("click"), ...mutation, ...pointer,
    button: z.enum(["left", "right", "middle"]).default("left") }).strict(),
  z.object({ action: z.literal("text"), ...mutation,
    text: z.string().min(1).max(4096).refine((text) => [...text].every((char) =>
      char === "\n" || char === "\t" || (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)),
    "Unsupported control character") }).strict(),
  z.object({ action: z.literal("key"), ...mutation,
    key: z.enum(["Enter", "Tab", "Escape", "Backspace", "Delete", "Left", "Up", "Right", "Down", "Home", "End"]) }).strict(),
  z.object({ action: z.literal("scroll"), ...mutation,
    dx: z.number().finite().min(-10000).max(10000), dy: z.number().finite().min(-10000).max(10000) }).strict(),
]);
export type ComputerInput = z.infer<typeof ComputerInputSchema>;

/** One interactive desktop has one pointer/focus; requests never overlap. */
export class PortalDesktop {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending: { id: string; resolve(value: Record<string, unknown>): void; reject(error: Error): void } | undefined;
  private sessionId: string | undefined;
  private observationId: string | undefined;
  private pipewireNodeId: number | undefined;
  private size: { width: number; height: number } | undefined;
  private opening: Promise<Record<string, unknown>> | undefined;
  private openError: Error | undefined;
  private busy = false;

  constructor(private readonly operations: OperationsStore) {}

  private desktopTarget(): Record<string, unknown> {
    // The portal selects a monitor, not an application window or filesystem target.
    return { desktop_backend: "wayland-portal", desktop_scope: "monitor", window_attribution: "unavailable",
      ...(this.pipewireNodeId === undefined ? {} : { pipewire_node_id: this.pipewireNodeId }),
      ...(this.size ? { coordinate_width: this.size.width, coordinate_height: this.size.height } : {}) };
  }

  status(): Record<string, unknown> {
    if (!this.sessionId) return {
      state: this.openError ? "failed" : "closed",
      message: this.openError ? `Desktop connection failed: ${this.openError.message}` : "Desktop control is closed.",
      ...(this.openError instanceof HostSpanError ? { error_details: this.openError.details } : {}),
      next_action: { tool: "computer", arguments: { action: "open" } },
    };
    return {
      ...this.desktopTarget(), session_id: this.sessionId, state: this.opening ? "awaiting_consent" : this.pending ? "processing" : "ready",
      message: this.opening ? "Select a screen and allow control in the desktop sharing dialog. You can close to cancel."
        : this.pending ? "A desktop action is processing. Wait before sending another input."
        : "Desktop connected. Observe the screen before choosing where to act.",
      next_action: { tool: "computer", arguments: { action: "observe", session_id: this.sessionId } },
      ...(this.opening || this.pending ? { retry_after_ms: 1000 } : {}),
    };
  }

  private start(): void {
    if (this.child) return;
    if (process.platform !== "linux" || process.env.XDG_SESSION_TYPE !== "wayland") {
      throw new HostSpanError("POLICY_UNENFORCEABLE", "This desktop backend requires a logged-in Linux Wayland session.");
    }
    const helper = fileURLToPath(new URL("./portal-worker.py", import.meta.url)).replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
    const child = spawn("/usr/bin/python3", ["-I", helper], {
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
          const reply = JSON.parse(line) as { event?: string; id: string; result?: Record<string, unknown>; error?: string; error_details?: Record<string, unknown> };
          if (reply.event === "closed") {
            this.fail(new Error("Desktop sharing ended. Open computer again to select a screen."));
            return;
          }
          if (!this.pending || reply.id !== this.pending.id) throw new Error("Unexpected desktop worker reply");
          const pending = this.pending;
          this.pending = undefined;
          if (reply.error) pending.reject(new HostSpanError(
            reply.error_details?.reason === "portal_local_timeout" ? "DEADLINE_EXCEEDED" : "INTERNAL_ERROR",
            reply.error, false, reply.error_details));
          else if (reply.result) pending.resolve(reply.result);
          else pending.reject(new Error("Desktop worker returned no result"));
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
    this.sessionId = this.observationId = this.size = this.pipewireNodeId = undefined;
    this.opening = undefined;
    this.pending?.reject(error);
    this.pending = undefined;
    // This process owns only its worker. Disconnecting its D-Bus connection revokes the portal session.
    child?.kill();
  }

  private call(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.start();
    const child = this.child;
    if (!child) throw new Error("Desktop worker did not start");
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      // Consent belongs to the live session, not a wall-clock deadline. Caller close,
      // OS response/revocation and worker failure still end it. Input/capture stay bounded.
      const timer = command.action === "open" ? undefined : setTimeout(() =>
        this.fail(new Error("Desktop worker deadline exceeded; input must not be replayed")), 10_000);
      this.pending = {
        id,
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  private async observe(): Promise<Record<string, unknown>> {
    const frame = await this.call({ action: "observe" });
    if (typeof frame.image !== "string" || frame.mime_type !== "image/png"
      || typeof frame.coordinate_width !== "number" || typeof frame.coordinate_height !== "number") {
      throw new Error("Desktop worker returned an invalid observation");
    }
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
        const sessionId = randomUUID();
        this.sessionId = sessionId;
        try {
          const opening = this.call({ action: "open" });
          this.opening = opening;
          void opening.then((result) => {
            if (this.sessionId !== sessionId) return;
            if (typeof result.pipewire_node_id === "number" && Number.isSafeInteger(result.pipewire_node_id) && result.pipewire_node_id >= 0) this.pipewireNodeId = result.pipewire_node_id;
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
          throw new HostSpanError("INTERNAL_ERROR", `Screen capture failed: ${error instanceof Error ? error.message : "unknown error"}`,
            true, { next_action: this.status().next_action });
        }
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
      try {
        await this.call(input);
      } catch (error) {
        return { state: "unknown", dispatched: "unknown", observation_required: true,
          error: error instanceof Error ? error.message : "Desktop input failed",
          message: "Input delivery is uncertain. Inspect the screen; do not resend automatically.",
          next_action: this.status().next_action };
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
