import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { PortalDesktop } from "../../src/computer/portal.js";
import { openDatabase } from "../../src/state/database.js";
import { OperationsRepo } from "../../src/state/operations-repo.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.skipIf(process.platform !== "linux")("observes after input and never resends delivered or ambiguous input, including after reconnect", async () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const db = openDatabase(":memory:");
  const operations = new OperationsRepo(db);
  const commands: Array<Record<string, unknown>> = [];
  let failObservation = false;
  let failInput = false;
  let failOpen = false;
  let revokeDuringObservation = false;
  let currentWorker: ChildProcessWithoutNullStreams;
  vi.mocked(spawn).mockImplementation(() => {
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
          : { dispatched: true } })}\n`);
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
    expect(delivered).toMatchObject({ dispatched: true, outcome_verified: false, observation_required: true });
    expect(commands.map((command) => command.action)).toEqual(["open", "observe", "text", "observe"]);
    expect(await desktop.run(input)).toMatchObject({ replayed: true, dispatched: true });
    await expect(desktop.run({ ...input, idempotency_key: "stale" })).rejects.toMatchObject({ code: "STALE_CONTENT" });
    failObservation = false;
    const next = await desktop.run({ action: "observe", session_id: first.session_id });
    failInput = true;
    const uncertain = { ...input, observation_id: next.observation_id, idempotency_key: "uncertain" };
    expect(await desktop.run(uncertain)).toMatchObject({ state: "unknown", dispatched: "unknown" });
    desktop.dispose();
    const commandCount = commands.length;
    expect(await desktop.run(uncertain)).toMatchObject({ state: "unknown" });
    expect(await desktop.run(input)).toMatchObject({ replayed: true, dispatched: true });
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
    await expect(desktop.run({ action: "observe", session_id: reopened.session_id })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(await desktop.run(input)).toMatchObject({ replayed: true, dispatched: true });
    const restored = await desktop.run({ action: "open" });
    expect(restored.session_id).not.toBe(reopened.session_id);
    await Promise.resolve();
    const fresh = await desktop.run({ action: "observe", session_id: restored.session_id });
    expect(fresh).toMatchObject({ state: "ready" });
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
