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
  const worker = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(worker as unknown as ChildProcessWithoutNullStreams);
  const commands: Array<Record<string, unknown>> = [];
  let failObservation = false;
  let failInput = false;
  worker.stdin.on("data", (data: Buffer) => {
    const command = JSON.parse(data.toString()) as Record<string, unknown>;
    commands.push(command);
    queueMicrotask(() => {
      if ((command.action === "observe" && failObservation) || (command.action === "text" && failInput)) {
        worker.stdout.write(`${JSON.stringify({ id: command.id, error: "injected transport failure" })}\n`);
      } else {
        worker.stdout.write(`${JSON.stringify({ id: command.id, result: command.action === "observe"
          ? { image: "cG5n", mime_type: "image/png", width: 400, height: 300,
            coordinate_width: 400, coordinate_height: 300 }
          : { dispatched: true } })}\n`);
      }
    });
  });
  const desktop = new PortalDesktop(operations);
  try {
    const opened = await desktop.run({ action: "open" });
    expect(opened).toMatchObject({ state: "awaiting_consent" });
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
    await expect(desktop.run({ ...input, text: "different" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  } finally {
    desktop.dispose();
    db.close();
  }
});
