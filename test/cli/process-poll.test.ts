import { createConnection } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { main } from "../../src/cli/index.js";
import { createInitialConfig } from "../../src/config/defaults.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { startDaemonControlServer } from "../../src/daemon/control.js";
import { OutputSpool } from "../../src/processes/output-spool.js";
import { createRuntime } from "../../src/runtime/create-runtime.js";
import type { ProcessPollToolInput } from "../../src/tools/schemas.js";

it("retrieves original native results through the owner channel with cursors, loss and expiry intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "hostspan-cli-poll-"));
  const configPath = join(root, "config.yaml");
  const config = createInitialConfig();
  config.server.data_dir = join(root, "state");
  writeConfigAtomic(configPath, config);
  const runtime = createRuntime(configPath);
  const id = "proc_retained_cli_fixture";
  runtime.processes.create({ process_id: id, idempotency_key: "retained-fixture", target_id: "fixture",
    argv_digest: "sha256:fixture", cwd_relative: ".", backend: "native", max_output_bytes: 16 });
  const spool = new OutputSpool(config.server.data_dir, id, 16);
  spool.append("stdout", Buffer.from("abcdefghijklmnopqrst"));
  runtime.processes.setBytes(id, "stdout", 20);
  runtime.processes.markTerminal(id, "failed", 7, null, "nonzero_exit", new Date(Date.now() + 60_000).toISOString());
  const start = vi.spyOn(runtime.supervisor, "start");
  const cancel = vi.spyOn(runtime.supervisor, "cancel");
  const calls: ProcessPollToolInput[] = [];
  const control = await startDaemonControlServer(configPath, () => {}, undefined, async (input) => {
    calls.push(input);
    return runtime.handlers.process_poll(input, "req_cli_poll_fixture");
  });
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const poll = async (...args: string[]) => {
    output.mockClear();
    const code = await main(["process", "poll", "--process", id, "--config", configPath, ...args]);
    return { code, body: JSON.parse(String(output.mock.calls[0]?.[0])) };
  };
  try {
    const first = await poll("--max-bytes", "8", "--wait-ms", "0");
    expect(first).toMatchObject({ code: 0, body: { process_id: id, state: "failed", exit_code: 7,
      exit_code_scope: "spawned_command", stdout: "efgh", next_stdout_cursor: 8, next_stderr_cursor: 0,
      stdout_dropped_bytes: 4, stdout_earliest_cursor: 4, output_expired: false, has_more_output: true } });
    const rest = await poll("--stdout-cursor", "8", "--stderr-cursor", "0", "--max-bytes", "64", "--wait-ms", "1500");
    expect(rest.body).toMatchObject({ stdout: "ijklmnopqrst", next_stdout_cursor: 20, has_more_output: false });
    expect(calls[1]).toMatchObject({ process_id: id, stdout_cursor: 8, stderr_cursor: 0, wait_ms: 1500, max_bytes: 64 });
    await expect(poll("--wait-ms", "10000")).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/1500/) });
    await expect(poll("--stdout-cursor", "-1")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(poll("--max-bytes")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(calls).toHaveLength(2);
    const denied = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(control.address);
      let data = "";
      socket.on("error", reject);
      socket.on("connect", () => socket.end(`${JSON.stringify({ token: "incorrect", action: "process_poll", input: { process_id: id } })}\n`));
      socket.on("data", chunk => { data += chunk.toString(); });
      socket.on("end", () => resolve(data));
    });
    expect(JSON.parse(denied)).toEqual({ ok: false });
    expect(calls).toHaveLength(2);
    runtime.db.prepare("UPDATE processes SET output_expires_at=? WHERE process_id=?").run(new Date(0).toISOString(), id);
    const expired = await poll("--stdout-cursor", "8");
    expect(expired.body).toMatchObject({ state: "failed", exit_code: 7, stdout: "", output_expired: true,
      next_stdout_cursor: 20, stdout_dropped_bytes: 12, has_more_output: false });
    expect(start).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    await control.close();
    await expect(poll()).rejects.toMatchObject({ code: "TARGET_NOT_READY" });
  } finally {
    output.mockRestore();
    await control.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
