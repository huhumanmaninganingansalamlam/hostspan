import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const specIndex = args.indexOf("--spec");
if (specIndex < 0 || !args[specIndex + 1]) throw new Error("pty worker requires --spec PATH");
const specPath = args[specIndex + 1];
const spec = JSON.parse(readFileSync(specPath, "utf8"));
rmSync(specPath, { force: true });

const sessionDir = join(spec.dataDir, "sessions", spec.session);
const socketPath = spec.socketPath;
const statusPath = join(sessionDir, "status.json");
const drainPath = join(sessionDir, "output-drained");
const spoolPath = join(spec.dataDir, "spools", "processes", spec.processId, "stdout.bin");
mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
mkdirSync(dirname(spoolPath), { recursive: true, mode: 0o700 });
mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
rmSync(socketPath, { force: true });
rmSync(drainPath, { force: true });
writeFileSync(spoolPath, "", { mode: 0o600 });

let ptyProcess;
let outputBytes = 0;
let terminationReason = null;
let finished = false;
let columns = spec.columns;
let rows = spec.rows;
const attached = new Set();

function writeStatus(fields) {
  const payload = {
    schema_version: 1,
    process_id: spec.processId,
    session: spec.session,
    worker_pid: process.pid,
    pty_pid: ptyProcess?.pid ?? null,
    columns,
    rows,
    output_bytes: outputBytes,
    updated_at: new Date().toISOString(),
    ...fields,
  };
  const temp = `${statusPath}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  renameSync(temp, statusPath);
}

function killProcessTree(signal) {
  if (!ptyProcess?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-ptyProcess.pid, signal);
    else ptyProcess.kill(signal);
  } catch {
    try {
      ptyProcess.kill(signal);
    } catch {
      // The terminal may already have exited.
    }
  }
}

function terminate(reason, graceMs = 500) {
  if (finished) return;
  terminationReason ??= reason;
  killProcessTree("SIGTERM");
  const timer = setTimeout(() => {
    if (!finished) killProcessTree("SIGKILL");
  }, Math.max(0, graceMs));
  timer.unref();
}

function appendOutput(data) {
  const bytes = Buffer.from(data, "utf8");
  const remaining = Math.max(0, spec.maxOutputBytes - outputBytes);
  const chunk = bytes.subarray(0, remaining);
  if (chunk.length > 0) {
    appendFileSync(spoolPath, chunk);
    outputBytes += chunk.length;
  }
  for (const socket of attached) {
    if (socket.destroyed) {
      attached.delete(socket);
      continue;
    }
    if (socket.writableLength > 1024 * 1024) {
      socket.destroy();
      attached.delete(socket);
      continue;
    }
    socket.write(chunk);
  }
  if (chunk.length < bytes.length && !terminationReason) terminate("output_limit", 0);
}

function controlBytes(keys) {
  const map = {
    Enter: "\r",
    Escape: "\u001b",
    Tab: "\t",
    "C-c": "\u0003",
    "C-d": "\u0004",
    "C-z": "\u001a",
  };
  return keys.map((key) => map[key] ?? "").join("");
}

function parseRequest(socket, initial) {
  let buffer = initial;
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const newline = buffer.indexOf(10);
    if (newline < 0) {
      if (buffer.length > 1024 * 1024) socket.destroy();
      return;
    }
    socket.off("data", onData);
    const line = buffer.subarray(0, newline).toString("utf8");
    const rest = buffer.subarray(newline + 1);
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      socket.end(`${JSON.stringify({ ok: false, error: "invalid_json" })}\n`);
      return;
    }
    void handleRequest(socket, request, rest);
  };
  socket.on("data", onData);
  if (buffer.length) onData(Buffer.alloc(0));
}

async function handleRequest(socket, request, rest) {
  if (request.op === "write") {
    if (finished) {
      socket.end(`${JSON.stringify({ ok: false, error: "session_exited" })}\n`);
      return;
    }
    if (Number.isInteger(request.columns) || Number.isInteger(request.rows)) {
      columns = Number.isInteger(request.columns) ? request.columns : columns;
      rows = Number.isInteger(request.rows) ? request.rows : rows;
      ptyProcess.resize(columns, rows);
      writeStatus({ status: "running", exit_code: null, signal: null, reason: null });
    }
    if (request.chars) ptyProcess.write(String(request.chars));
    const controls = controlBytes(Array.isArray(request.control_keys) ? request.control_keys : []);
    if (controls) ptyProcess.write(controls);
    socket.end(`${JSON.stringify({ ok: true })}\n`);
    return;
  }
  if (request.op === "terminate") {
    terminate(String(request.reason ?? "cancel_requested"), Number(request.grace_ms ?? 500));
    socket.end(`${JSON.stringify({ ok: true })}\n`);
    return;
  }
  if (request.op === "attach") {
    if (finished) {
      socket.end(`${JSON.stringify({ ok: false, error: "session_exited" })}\n`);
      return;
    }
    socket.write(`${JSON.stringify({ ok: true, mode: "attach" })}\n`);
    try {
      if (existsSync(spoolPath)) {
        const content = readFileSync(spoolPath);
        socket.write(content.subarray(Math.max(0, content.length - spec.attachHistoryBytes)));
      }
    } catch {
      // Live output still works if historical output cannot be replayed.
    }
    attached.add(socket);
    socket.on("close", () => attached.delete(socket));
    socket.on("error", () => attached.delete(socket));
    if (!request.read_only) {
      if (rest.length) ptyProcess.write(rest.toString("utf8"));
      socket.on("data", (chunk) => ptyProcess.write(chunk.toString("utf8")));
    }
    return;
  }
  socket.end(`${JSON.stringify({ ok: false, error: "unknown_op" })}\n`);
}

const server = createServer((socket) => parseRequest(socket, Buffer.alloc(0)));

async function main() {
  writeStatus({ status: "starting", exit_code: null, signal: null, reason: null, started_at: new Date().toISOString() });
  const pty = await import("node-pty");
  const program = spec.argv[0];
  if (!program) throw new Error("interactive argv is empty");
  ptyProcess = pty.spawn(program, spec.argv.slice(1), {
    name: process.env.TERM || "xterm-256color",
    cols: spec.columns,
    rows: spec.rows,
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
  });
  ptyProcess.onData(appendOutput);
  ptyProcess.onExit(({ exitCode, signal }) => {
    const settle = setTimeout(() => {
      finished = true;
      writeFileSync(drainPath, "", { mode: 0o600 });
      writeStatus({
        status: "exited",
        exit_code: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal ? String(signal) : null,
        reason: terminationReason,
        ended_at: new Date().toISOString(),
      });
      for (const socket of attached) socket.end();
      attached.clear();
      server.close(() => process.exit(0));
      const forceExit = setTimeout(() => process.exit(0), 250);
      forceExit.unref();
    }, 75);
    settle.unref();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      resolve();
    });
  });
  writeStatus({ status: "running", exit_code: null, signal: null, reason: null, started_at: new Date().toISOString() });

  const deadlineDelay = new Date(spec.deadlineAt).getTime() - Date.now();
  if (Number.isFinite(deadlineDelay)) {
    if (deadlineDelay <= 0) terminate("deadline_exceeded", 0);
    else {
      const deadlineTimer = setTimeout(() => terminate("deadline_exceeded", 500), deadlineDelay);
      deadlineTimer.unref();
    }
  }
}

main().catch((error) => {
  try {
    finished = true;
    writeStatus({
      status: "failed",
      exit_code: null,
      signal: null,
      reason: `worker_start_failed:${error instanceof Error ? error.message : String(error)}`,
      ended_at: new Date().toISOString(),
    });
  } catch {
    // Nothing else can make the failed worker recoverable.
  }
  process.exit(1);
});
