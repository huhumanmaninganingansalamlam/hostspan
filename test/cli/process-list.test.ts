import { createConnection } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { main } from "../../src/cli/index.js";
import { createInitialConfig } from "../../src/config/defaults.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { startDaemonControlServer } from "../../src/daemon/control.js";
import { createRuntime } from "../../src/runtime/create-runtime.js";

it("discovers original handles then polls them without execution, cross-path leakage or invented liveness", async () => {
  const root = mkdtempSync(join(tmpdir(), "hostspan-cli-list-"));
  const configPath = join(root, "config.yaml");
  const config = createInitialConfig();
  config.server.data_dir = join(root, "state");
  config.targets.local = { label: "fixture", provider: "local", root,
    capabilities: ["read"], deny_globs: ["private", "private/**"], ignore_globs: [] };
  for (const path of ["project", "project/nested", "project-other", "private"]) mkdirSync(join(root, path), { recursive: true });
  writeConfigAtomic(configPath, config);
  const runtime = createRuntime(configPath);
  const id = (n: number) => `proc_${n.toString(16).padStart(32, "0")}`;
  for (const [n, cwd, backend, state, exit] of [
    [1, "project", "native", "failed", 7],
    [2, "project/nested", "pty", "unknown", null],
    [3, "project-other", "native", "succeeded", 0],
    [4, "project", "native", "running", null],
  ] as const) {
    runtime.processes.create({ process_id: id(n), idempotency_key: `key-${n}`, target_id: "local",
      argv_digest: "must-not-leak-command", cwd_relative: cwd, backend });
    if (state === "running") runtime.processes.markRunning(id(n), null, null);
    else runtime.processes.markTerminal(id(n), state, exit, null, "retained-fixture");
  }
  const start = vi.spyOn(runtime.supervisor, "start");
  const cancel = vi.spyOn(runtime.supervisor, "cancel");
  const list = vi.fn(async input => runtime.handlers.process_list(input, "req_cli_list_fixture"));
  const control = await startDaemonControlServer(configPath, () => {}, undefined,
    async input => runtime.handlers.process_poll(input, "req_cli_poll_fixture"), list);
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const cli = async (...args: string[]) => {
    output.mockClear();
    expect(await main(["process", ...args, "--config", configPath])).toBe(0);
    return JSON.parse(String(output.mock.calls[0]?.[0]));
  };
  const ipc = async (token: string, input: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = createConnection(control.address);
    let data = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.end(`${JSON.stringify({ token, action: "process_list", input })}\n`));
    socket.on("data", chunk => { data += chunk.toString(); });
    socket.on("end", () => resolve(JSON.parse(data)));
  });
  try {
    const active = await cli("list", "--target", "local", "--cwd", "project");
    expect(active.processes.map((p: { process_id: string }) => p.process_id)).toEqual([id(4)]);
    const first = await cli("list", "--target", "local", "--cwd", "project", "--active-only", "false", "--limit", "2");
    expect(first).toMatchObject({ truncated: true, cursor: id(2), processes: [
      { process_id: id(4), state: "running" }, { process_id: id(2), state: "unknown", exit_code: null },
    ] });
    const next = await cli("list", "--target", "local", "--cwd", "project", "--active-only", "false", "--cursor", first.cursor);
    expect(next).toMatchObject({ truncated: false, processes: [{ process_id: id(1), cwd: "project", state: "failed", exit_code: 7 }] });
    expect(next.processes).toHaveLength(1);
    expect(Object.keys(next.processes[0]).sort()).toEqual(["process_id", "target_id", "cwd", "backend", "state",
      "started_at", "ended_at", "exit_code", "reason", "output_expires_at"].sort());
    expect(JSON.stringify(first)).not.toContain("must-not-leak-command");
    const polled = await cli("poll", "--process", next.processes[0].process_id);
    expect(polled).toMatchObject({ process_id: id(1), state: "failed", exit_code: 7 });
    for (const args of [["--active-only", "yes"], ["--limit", "501"], ["--cursor", "invalid"], ["--cwd"], ["--target", "again"]]) {
      await expect(cli("list", "--target", "local", ...args)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    await expect(cli("list", "--target", "missing")).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    await expect(cli("list", "--target", "local", "--cwd", "../outside")).rejects.toMatchObject({ code: "PATH_OUTSIDE_TARGET" });
    await expect(cli("list", "--target", "local", "--cwd", "private")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    const calls = list.mock.calls.length;
    expect(await ipc("wrong-token", { target_id: "local" })).toEqual({ ok: false });
    const token = readFileSync(join(config.server.data_dir, "daemon-control-token"), "utf8").trim();
    expect(await ipc(token, { target_id: "local", limit: 501 })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(list).toHaveBeenCalledTimes(calls);
    expect(start).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    await control.close();
    await expect(cli("list", "--target", "local")).rejects.toMatchObject({ code: "TARGET_NOT_READY" });
  } finally {
    output.mockRestore();
    await control.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
