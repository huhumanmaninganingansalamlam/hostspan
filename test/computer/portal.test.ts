import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { PortalDesktop } from "../../src/computer/portal.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.useRealTimers(); });

it.skipIf(process.platform !== "linux")("waits for actual portal consent and distinguishes local setup expiry", () => {
  execFileSync("python3", ["-I", "test/computer/portal-request.py"], { stdio: "pipe" });
});

it.skipIf(process.platform !== "linux")("observes after input and never resends delivered or ambiguous input, including after reconnect", async () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const db = openDatabase(":memory:");
  const operations = new OperationsRepo(db);
  const commands: Array<Record<string, unknown>> = [];
  let nextNodeId = 73;
  let failObservation = false;
  let failInput = false;
  let failOpen = false;
  let revokeDuringObservation = false;
  let currentWorker: ChildProcessWithoutNullStreams;
  vi.mocked(spawn).mockImplementation(() => {
  const nodeId = nextNodeId++;
  const worker = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  worker.stdin.on("data", (data: Buffer) => {
    const command = JSON.parse(data.toString()) as Record<string, unknown>;
    commands.push(command);
    queueMicrotask(() => {
      if (command.action === "observe" && revokeDuringObservation) {
        worker.stdout.write('{"event":"closed"}\n');
        return;
      }
      if ((command.action === "open" && failOpen) || (command.action === "observe" && failObservation) || (command.action === "text" && failInput)) {
        worker.stdout.write(`${JSON.stringify({ id: command.id, error: "injected transport failure" })}\n`);
      } else {
        worker.stdout.write(`${JSON.stringify({ id: command.id, result: command.action === "observe"
          ? { image: "cG5n", mime_type: "image/png", width: 400, height: 300,
            coordinate_width: 400, coordinate_height: 300 }
          : { dispatched: true, pipewire_node_id: nodeId } })}\n`);
      }
    });
  });
    currentWorker = worker as unknown as ChildProcessWithoutNullStreams;
    return worker as unknown as ChildProcessWithoutNullStreams;
  });
  const desktop = new PortalDesktop(operations);
  try {
    const opened = await desktop.run({ action: "open" });
    expect(opened).toMatchObject({ state: "awaiting_consent", next_action: {
      tool: "computer", arguments: { action: "observe", session_id: opened.session_id },
    } });
    const resumed = await desktop.run({ action: "open" });
    expect(resumed.session_id).toBe(opened.session_id);
    expect(commands.filter((command) => command.action === "open")).toHaveLength(1);
    // The fake portal resolves consent asynchronously, like a user accepting the OS dialog.
    await Promise.resolve();
    const first = await desktop.run({ action: "observe", session_id: opened.session_id });
    const input = { action: "text", session_id: first.session_id, observation_id: first.observation_id,
      text: "한글-END", idempotency_key: "delivered" };
    failObservation = true;
    const delivered = await desktop.run(input);
    expect(delivered).toMatchObject({ dispatched: true, outcome_verified: false, observation_required: true,
      session_id: first.session_id, desktop_backend: "wayland-portal", desktop_scope: "monitor",
      pipewire_node_id: 73, window_attribution: "unavailable", coordinate_width: 400, coordinate_height: 300 });
    expect(JSON.parse(String(operations.get("delivered")?.result_json))).toMatchObject({
      session_id: first.session_id, pipewire_node_id: 73, outcome_verified: false,
    });
    expect(commands.map((command) => command.action)).toEqual(["open", "observe", "text", "observe"]);
    expect(await desktop.run(input)).toMatchObject({ replayed: true, dispatched: true, session_id: first.session_id, pipewire_node_id: 73 });
    await expect(desktop.run({ ...input, idempotency_key: "stale" })).rejects.toMatchObject({ code: "STALE_CONTENT" });
    failObservation = false;
    const next = await desktop.run({ action: "observe", session_id: first.session_id });
    failInput = true;
    const uncertain = { ...input, observation_id: next.observation_id, idempotency_key: "uncertain" };
    expect(await desktop.run(uncertain)).toMatchObject({ state: "unknown", dispatched: "unknown" });
    desktop.dispose();
    const commandCount = commands.length;
    expect(await desktop.run(uncertain)).toMatchObject({ state: "unknown" });
    expect(await desktop.run(input)).toMatchObject({ replayed: true, dispatched: true, session_id: first.session_id, pipewire_node_id: 73 });
    expect(commands).toHaveLength(commandCount);
    failOpen = true;
    await desktop.run({ action: "open" });
    await Promise.resolve();
    expect(desktop.status()).toMatchObject({ state: "failed", next_action: { arguments: { action: "open" } } });
    failOpen = false;
    const reopened = await desktop.run({ action: "open" });
    await Promise.resolve();
    expect(desktop.status()).toMatchObject({ state: "ready", session_id: reopened.session_id });
    // The portal notifies the owner when OS sharing is revoked. The next open must request fresh consent.
    currentWorker!.stdout.emit("data", '{"event":"closed"}\n');
    expect(desktop.status()).toMatchObject({ state: "failed", next_action: { arguments: { action: "open" } } });
    await expect(desktop.run({ action: "observe", session_id: reopened.session_id })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(await desktop.run(input)).toMatchObject({ replayed: true, dispatched: true, session_id: first.session_id, pipewire_node_id: 73 });
    const restored = await desktop.run({ action: "open" });
    expect(restored.session_id).not.toBe(reopened.session_id);
    await Promise.resolve();
    const fresh = await desktop.run({ action: "observe", session_id: restored.session_id });
    expect(fresh).toMatchObject({ state: "ready" });
    expect(fresh.pipewire_node_id).not.toBe(73);
    failInput = false;
    revokeDuringObservation = true;
    const closingInput = { ...input, session_id: restored.session_id, observation_id: fresh.observation_id, idempotency_key: "closing" };
    expect(await desktop.run(closingInput)).toMatchObject({ dispatched: true, observation_required: true,
      next_action: { arguments: { action: "open" } } });
    expect(await desktop.run(closingInput)).toMatchObject({ replayed: true, dispatched: true });
    revokeDuringObservation = false;
    const final = await desktop.run({ action: "open" });
    await Promise.resolve();
    expect(await desktop.run({ action: "close", session_id: final.session_id })).toMatchObject({ closed: true, state: "closed" });
    await expect(desktop.run({ ...input, text: "different" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  } finally {
    desktop.dispose();
    db.close();
  }
});


it.skipIf(process.platform !== "linux")("keeps consent live beyond old deadlines and preserves portal response provenance and close cleanup", async () => {
  vi.useFakeTimers();
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const db = openDatabase(":memory:");
  const workers: Array<{ worker: ReturnType<typeof makeWorker>; command: Record<string, unknown> }> = [];
  function makeWorker() {
    return Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
  }
  vi.mocked(spawn).mockImplementation(() => {
    const worker = makeWorker();
    worker.stdin.on("data", (data: Buffer) => workers.push({ worker, command: JSON.parse(data.toString()) }));
    return worker as unknown as ChildProcessWithoutNullStreams;
  });
  const desktop = new PortalDesktop(new OperationsRepo(db));
  try {
    const opened = await desktop.run({ action: "open" });
    await vi.advanceTimersByTimeAsync(240_000);
    expect(await desktop.run({ action: "observe", session_id: opened.session_id })).toMatchObject({
      session_id: opened.session_id, state: "awaiting_consent", dispatched: false,
    });
    expect(workers).toHaveLength(1);
    const firstWorker = workers[0];
    if (!firstWorker) throw new Error("Missing consent worker");
    expect(firstWorker.worker.kill).not.toHaveBeenCalled();
    firstWorker.worker.stdout.write(`${JSON.stringify({ id: firstWorker.command.id, result: { pipewire_node_id: 81 } })}\n`);
    await Promise.resolve();
    expect(desktop.status()).toMatchObject({ state: "ready", session_id: opened.session_id, pipewire_node_id: 81 });
    desktop.dispose();

    for (const response of [1, 2]) {
      const pending = await desktop.run({ action: "open" });
      const lastWorker = workers.at(-1);
      if (!lastWorker) throw new Error("Missing consent worker");
      const { worker, command } = lastWorker;
      const details = { reason: "portal_response", portal_phase: "Start", portal_response: response };
      worker.stdout.write(`${JSON.stringify({ id: command.id, error: "Portal response", error_details: details })}\n`);
      await Promise.resolve();
      await expect(desktop.run({ action: "observe", session_id: pending.session_id })).rejects.toMatchObject({
        code: "INTERNAL_ERROR", details,
      });
      expect(worker.kill).toHaveBeenCalledOnce();
    }
    const setup = await desktop.run({ action: "open" });
    const setupWorker = workers.at(-1);
    if (!setupWorker) throw new Error("Missing setup worker");
    const { worker, command } = setupWorker;
    const details = { reason: "portal_local_timeout", portal_phase: "CreateSession" };
    worker.stdout.write(`${JSON.stringify({ id: command.id, error: "Local setup deadline", error_details: details })}\n`);
    await Promise.resolve();
    await expect(desktop.run({ action: "observe", session_id: setup.session_id })).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED", details,
    });
    const closing = await desktop.run({ action: "open" });
    const last = workers.at(-1);
    if (!last) throw new Error("Missing closing worker");
    expect(await desktop.run({ action: "close", session_id: closing.session_id })).toMatchObject({ closed: true, state: "closed" });
    expect(last.worker.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(desktop.status().state).toBe("closed");
    expect(workers.filter(({ command }) => command.action !== "open")).toHaveLength(0);
  } finally {
    desktop.dispose();
    db.close();
  }
});
