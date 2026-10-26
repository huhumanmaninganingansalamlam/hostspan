import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerInputSchema, PortalDesktop } from "../../src/computer/portal.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.useRealTimers(); });

it.skipIf(process.platform !== "linux")("waits for actual consent and balances physical keys without clipboard access", () => {
  execFileSync("python3", ["-I", "test/computer/portal-request.py"], { stdio: "pipe" });
});

it("accepts physical key positions and optional Shift without changing legacy arguments", () => {
  const legacy = { action: "key", key: "Enter", session_id: "00000000-0000-4000-8000-000000000001",
    observation_id: "00000000-0000-4000-8000-000000000002", idempotency_key: "legacy-key" };
  expect(ComputerInputSchema.parse(legacy)).toEqual(legacy);
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    expect(ComputerInputSchema.parse({ ...legacy, key: `Key${letter}`, modifiers: ["Shift"] })).toMatchObject({
      key: `Key${letter}`, modifiers: ["Shift"],
    });
  }
  for (const modifiers of [["Control"], ["Shift", "Shift"], "Shift", null]) {
    expect(ComputerInputSchema.safeParse({ ...legacy, modifiers }).success).toBe(false);
  }
  expect(ComputerInputSchema.safeParse({ ...legacy, key: "a" }).success).toBe(false);
});

it("uses the native helper with the same session, observation and cancellation contract", async () => {
  const db = openDatabase(":memory:");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  const commands: Array<Record<string, unknown>> = [];
  let capturePending = true;
  const pendingCaptureDetails = { reason: "native_capture_pending", capture_phase: "screen_capture", retry_after_ms: 1000 };
  function makeWorker() {
    const worker = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    worker.stdin.on("data", (data: Buffer) => {
      const command = JSON.parse(data.toString()) as Record<string, unknown>;
      commands.push(command);
      if (command.action === "observe" && capturePending) {
        capturePending = false;
        queueMicrotask(() => worker.stdout.write(`${JSON.stringify({ id: command.id,
          error: "Display capture is still processing", error_details: pendingCaptureDetails })}\n`));
        return;
      }
      if (command.action !== "open") queueMicrotask(() => worker.stdout.write(`${JSON.stringify({
        id: command.id, result: command.action === "observe" ? {
          image: "cG5n", mime_type: "image/png", width: 800, height: 600, coordinate_width: 800, coordinate_height: 600,
          capture_started_at: "2026-10-25T18:09:40.463Z", capture_completed_at: "2026-10-25T18:09:46.000Z",
        } : { closed: true },
      })}\n`));
    });
    return worker;
  }
  let worker = makeWorker();
  vi.mocked(spawn).mockImplementation(() => worker as unknown as ChildProcessWithoutNullStreams);
  const desktop = new PortalDesktop(new OperationsRepo(db));
  try {
    const opened = await desktop.run({ action: "open" });
    expect(spawn).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining(["-Sta", "-File"]), expect.any(Object));
    expect(desktop.status()).toMatchObject({ state: "connecting", desktop_backend: "windows-native" });
    expect(desktop.status()).toMatchObject({ session_created_at: expect.any(String), lifetime: "explicit_close_or_os_end_or_worker_exit" });
    const command = commands[0];
    if (!command) throw new Error("Missing native open command");
    worker.stdout.write('{"event":"permission_required","permission":"screen_recording"}\n');
    expect(desktop.status()).toMatchObject({ state: "awaiting_consent", required_os_permission: "screen_recording" });
    worker.stdout.write(`${JSON.stringify({ id: command.id, result: { display_id: "\\\\.\\DISPLAY1" } })}\n`);
    await Promise.resolve();
    await expect(desktop.run({ action: "observe", session_id: opened.session_id })).rejects.toMatchObject({
      details: pendingCaptureDetails, retryable: true,
    });
    expect(desktop.status()).toMatchObject({ state: "unavailable", frame_ready: false, session_id: opened.session_id });
    expect(worker.kill).not.toHaveBeenCalled();
    let image = await desktop.run({ action: "observe", session_id: opened.session_id });
    expect(image).toMatchObject({ desktop_backend: "windows-native", display_id: "\\\\.\\DISPLAY1", coordinate_width: 800,
      session_id: opened.session_id, state: "ready", capture_started_at: "2026-10-25T18:09:40.463Z",
      capture_completed_at: "2026-10-25T18:09:46.000Z" });
    const legacy = { action: "key", key: "Enter", session_id: opened.session_id,
      observation_id: image.observation_id, idempotency_key: "pre-upgrade-key" };
    const oldOperations = new OperationsRepo(db);
    oldOperations.resolve(legacy.idempotency_key, "computer", legacy);
    oldOperations.setState(legacy.idempotency_key, "completed", { dispatched: true });
    const beforeLegacyReplay = commands.length;
    expect(await desktop.run(legacy)).toMatchObject({ replayed: true, dispatched: true });
    expect(commands).toHaveLength(beforeLegacyReplay);
    const physical = { ...legacy, key: "KeyR", modifiers: ["Shift"], idempotency_key: "physical-shift-r" };
    image = await desktop.run(physical);
    expect(image).toMatchObject({ state: "completed", dispatched: true });
    expect(commands.at(-2)).toMatchObject(physical);
    const afterPhysical = commands.length;
    expect(await desktop.run(physical)).toMatchObject({ replayed: true, dispatched: true });
    expect(commands).toHaveLength(afterPhysical);
    capturePending = true;
    const text = { action: "text", session_id: opened.session_id, observation_id: image.observation_id,
      text: "native-capture-check", idempotency_key: "native-delivered" };
    expect(await desktop.run(text)).toMatchObject({ state: "completed", dispatched: true,
      observation_required: true, observation_error_details: pendingCaptureDetails });
    const commandCount = commands.length;
    expect(await desktop.run(text)).toMatchObject({ replayed: true, dispatched: true });
    expect(commands).toHaveLength(commandCount);
    expect(await desktop.run({ action: "observe", session_id: opened.session_id })).toMatchObject({
      session_id: opened.session_id, state: "ready" });
    expect(worker.kill).not.toHaveBeenCalled();
    expect(await desktop.run({ action: "close", session_id: opened.session_id })).toMatchObject({ state: "closed" });
    expect(worker.kill).toHaveBeenCalledOnce();
    worker = makeWorker();
    const retry = await desktop.run({ action: "open" });
    const retryCommand = commands.at(-1);
    if (!retryCommand) throw new Error("Missing native retry command");
    const details = { reason: "macos_gui_launch_required", permission: "screen_recording" };
    worker.stdout.write(`${JSON.stringify({ id: retryCommand.id,
      error: "Start HostSpan from its macOS app", error_details: details })}\n`);
    await Promise.resolve();
    expect(desktop.status()).toMatchObject({ state: "failed", error_details: details });
    expect(desktop.status()).not.toHaveProperty("required_os_permission");
    await expect(desktop.run({ action: "observe", session_id: retry.session_id })).rejects.toMatchObject({
      code: "TARGET_NOT_READY", details,
    });
  } finally {
    desktop.dispose();
    if (platform) Object.defineProperty(process, "platform", platform);
    db.close();
  }
});

it.skipIf(process.platform !== "linux")("keeps a timed-out observation alive, consumes its late reply once, and still closes explicitly", async () => {
  vi.useFakeTimers();
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const db = openDatabase(":memory:");
  const worker = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  const commands: Array<Record<string, unknown>> = [];
  let holdCapture = false;
  const frame = { image: "cG5n", mime_type: "image/png", coordinate_width: 800, coordinate_height: 600 };
  const reply = (command: Record<string, unknown>, result: Record<string, unknown>) =>
    worker.stdout.write(`${JSON.stringify({ id: command.id, result })}\n`);
  worker.stdin.on("data", (data: Buffer) => {
    const command = JSON.parse(data.toString()) as Record<string, unknown>;
    commands.push(command);
    if (command.action === "observe" && holdCapture) return;
    queueMicrotask(() => reply(command, command.action === "observe" ? frame : { dispatched: true }));
  });
  vi.mocked(spawn).mockImplementation(() => worker as unknown as ChildProcessWithoutNullStreams);
  const desktop = new PortalDesktop(new OperationsRepo(db));
  try {
    const opened = await desktop.run({ action: "open" });
    await vi.advanceTimersByTimeAsync(0);
    const first = await desktop.run({ action: "observe", session_id: opened.session_id });
    holdCapture = true;
    const input = { action: "text", session_id: opened.session_id, observation_id: first.observation_id,
      text: "already-delivered", idempotency_key: "slow-followup" };
    const delivered = desktop.run(input);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await delivered).toMatchObject({ state: "completed", dispatched: true, clipboard_modified: true,
      observation_required: true, observation_error_details: { reason: "desktop_observation_timeout" },
      next_action: { arguments: { action: "observe", session_id: opened.session_id } } });
    expect(desktop.status()).toMatchObject({ session_id: opened.session_id, state: "processing" });
    expect(worker.kill).not.toHaveBeenCalled();
    const count = commands.length;
    expect(await desktop.run(input)).toMatchObject({ dispatched: true, replayed: true });
    expect(await desktop.run({ action: "open" })).toMatchObject({ session_id: opened.session_id });
    await expect(desktop.run({ ...input, idempotency_key: "new-input" })).rejects.toMatchObject({ code: "SERVER_BUSY" });
    expect(commands).toHaveLength(count);

    // An observer can time out repeatedly without sending a second capture.
    const waiting = expect(desktop.run({ action: "observe", session_id: opened.session_id })).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED", details: { reason: "desktop_observation_timeout" },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await waiting;
    expect(commands).toHaveLength(count);
    const capture = commands.at(-1);
    if (!capture) throw new Error("Missing original capture");
    reply(capture, frame);
    const recovered = await desktop.run({ action: "observe", session_id: opened.session_id });
    expect(recovered).toMatchObject({ session_id: opened.session_id, state: "ready", image: "cG5n" });
    expect(commands).toHaveLength(count);
    expect(worker.kill).not.toHaveBeenCalled();

    // Explicit close can finish while an expired capture still has a reply pending.
    const expired = expect(desktop.run({ action: "observe", session_id: opened.session_id })).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expired;
    expect(await desktop.run({ action: "close", session_id: opened.session_id })).toMatchObject({ closed: true, state: "closed" });
    expect(worker.kill).toHaveBeenCalledOnce();
    expect(commands.filter((command) => command.action === "text")).toHaveLength(1);
    expect(commands.filter((command) => command.action === "observe")).toHaveLength(3);
  } finally {
    desktop.dispose();
    db.close();
  }
});

it.skipIf(process.platform !== "linux")("observes after input and never resends delivered or ambiguous input, including after reconnect", async () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const db = openDatabase(":memory:");
  const operations = new OperationsRepo(db);
  const commands: Array<Record<string, unknown>> = [];
  let nextNodeId = 73;
  let failObservation = false;
  const captureDetails = { reason: "portal_capture_no_frame", capture_source_buffers: 0,
    capture_pipeline_state: "playing", capture_pending_state: "void-pending", capture_eos: false };
  let failInput = false;
  let failOpen = false;
  let revokeDuringObservation = false;
  let currentWorker: ChildProcessWithoutNullStreams | undefined;
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
        worker.stdout.write(`${JSON.stringify({ id: command.id, error: "injected transport failure",
          ...(command.action === "observe" ? { error_details: captureDetails } : {}) })}\n`);
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
    expect(desktop.status()).toMatchObject({ state: "ready", frame_ready: true });
    // A failed fresh capture must not leave READY or authorize input using the old image.
    failObservation = true;
    await expect(desktop.run({ action: "observe", session_id: first.session_id })).rejects.toMatchObject({
      code: "INTERNAL_ERROR", details: captureDetails,
    });
    expect(desktop.status()).toMatchObject({ state: "unavailable", frame_ready: false,
      session_id: first.session_id, error_details: captureDetails });
    const beforeStale = commands.length;
    await expect(desktop.run({ action: "key", key: "Enter", session_id: first.session_id,
      observation_id: first.observation_id, idempotency_key: "failed-capture-stale" })).rejects.toMatchObject({ code: "STALE_CONTENT" });
    expect(commands).toHaveLength(beforeStale);
    expect(currentWorker?.kill).not.toHaveBeenCalled();
    failObservation = false;
    const refreshed = await desktop.run({ action: "observe", session_id: first.session_id });
    expect(desktop.status()).toMatchObject({ state: "ready", frame_ready: true });
    const input = { action: "text", session_id: first.session_id, observation_id: refreshed.observation_id,
      text: "한글-END", idempotency_key: "delivered" };
    failObservation = true;
    const delivered = await desktop.run(input);
    expect(delivered).toMatchObject({ dispatched: true, outcome_verified: false, observation_required: true,
      observation_error_details: captureDetails,
      session_id: first.session_id, desktop_backend: "wayland-portal", desktop_scope: "monitor",
      pipewire_node_id: 73, window_attribution: "unavailable", coordinate_width: 400, coordinate_height: 300 });
    expect(JSON.parse(String(operations.get("delivered")?.result_json))).toMatchObject({
      session_id: first.session_id, pipewire_node_id: 73, outcome_verified: false,
    });
    expect(commands.map((command) => command.action)).toEqual(["open", "observe", "observe", "observe", "text", "observe"]);
    expect(await desktop.run(input)).toMatchObject({ replayed: true, dispatched: true, session_id: first.session_id, pipewire_node_id: 73 });
    await expect(desktop.run({ action: "observe", session_id: first.session_id })).rejects.toMatchObject({
      code: "INTERNAL_ERROR", details: captureDetails,
    });
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
