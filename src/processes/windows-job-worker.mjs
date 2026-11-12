import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createRequire } from "node:module";
import { resolveWindowsCommand } from "./windows-command.mjs";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

function lastErrorFunctions() {
  const koffi = createRequire(import.meta.url)("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  const HANDLE = koffi.pointer("HANDLE", koffi.opaque());
  return {
    create: kernel32.func("CreateJobObjectW", HANDLE, ["void *", "str16"]),
    set: kernel32.func("SetInformationJobObject", "bool", [HANDLE, "int", "void *", "uint32_t"]),
    assign: kernel32.func("AssignProcessToJobObject", "bool", [HANDLE, HANDLE]),
    current: kernel32.func("GetCurrentProcess", HANDLE, []),
    last: kernel32.func("GetLastError", "uint32_t", []),
  };
}

function createKillOnCloseJob() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(`Windows Job Object worker requires win32/x64, got ${process.platform}/${process.arch}`);
  }
  const api = lastErrorFunctions();
  const job = api.create(null, null);
  if (!job) throw new Error(`CreateJobObjectW failed: ${api.last()}`);

  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on Windows x64.
  // LimitFlags is the third member of BasicLimitInformation, at offset 16.
  const info = Buffer.alloc(144);
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
  if (!api.set(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, info.length)) {
    throw new Error(`SetInformationJobObject failed: ${api.last()}`);
  }
  if (!api.assign(job, api.current())) {
    throw new Error(`AssignProcessToJobObject failed: ${api.last()}`);
  }
  return job;
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function resolveCommand(program, argv, cwd, env) {
  return resolveWindowsCommand(program, argv, cwd, env);
}

export function spawnWindowsJobWorker(input) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(`Windows Job Object backend requires win32/x64, got ${process.platform}/${process.arch}`);
  }
  const dir = join(input.dataDir, "spools", "processes", input.processId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const specPath = join(dir, `windows-job-${process.pid}.json`);
  const readyPath = join(dir, "windows-job-ready.json");
  rmSync(readyPath, { force: true });
  writeFileSync(specPath, `${JSON.stringify({ cwd: input.cwd, argv: input.argv, env: input.env, readyPath })}\n`, { mode: 0o600 });
  try { chmodSync(specPath, 0o600); } catch { /* Windows ACLs are authoritative. */ }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--spec", specPath], {
    detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
  });
  const ready = (async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() <= deadline) {
      let status;
      try {
        if (existsSync(readyPath)) status = JSON.parse(readFileSync(readyPath, "utf8"));
      } catch { /* Atomic replacement can race a Windows reader. */ }
      if (status?.state === "running" && status.target_pid && status.worker_pid) return { workerPid: status.worker_pid, targetPid: status.target_pid };
      if (status?.state === "failed") throw new Error(status.reason ?? "Windows Job Object worker failed to launch the target process.");
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Windows Job Object worker exited before launch receipt (exit=${child.exitCode}, signal=${child.signalCode ?? "none"}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Windows Job Object worker did not produce a launch receipt.");
  })();
  return { child, ready };
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint && process.argv.includes("--probe")) {
  createKillOnCloseJob();
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  process.stdout.write(`job-object-ok child=${child.pid}\n`);
} else if (isEntrypoint) {
  const specIndex = process.argv.indexOf("--spec");
  const specPath = specIndex >= 0 ? process.argv[specIndex + 1] : undefined;
  if (!specPath) throw new Error("windows job worker requires --spec PATH");
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  rmSync(specPath, { force: true });

  // Keep the opaque Job Object handle reachable for the worker lifetime.
  // If this worker exits or is killed, Windows closes the handle and the
  // kernel terminates every process that inherited membership from it.
  const jobHandle = createKillOnCloseJob();
  void jobHandle;

  try {
    const command = resolveCommand(spec.argv[0], spec.argv.slice(1), spec.cwd, spec.env);
    const child = spawn(command.program, command.argv, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      detached: false,
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments === true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });

    let ready = false;
    child.once("spawn", () => {
      ready = true;
      atomicJson(spec.readyPath, { state: "running", worker_pid: process.pid, target_pid: child.pid ?? null });
    });
    child.once("error", (error) => {
      if (!ready) atomicJson(spec.readyPath, { state: "failed", worker_pid: process.pid, target_pid: null, reason: error.message });
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 127;
    });
    child.once("close", (code) => {
      process.exitCode = code ?? 1;
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    atomicJson(spec.readyPath, { state: "failed", worker_pid: process.pid, target_pid: null, reason });
    process.stderr.write(`${reason}\n`);
    process.exitCode = 127;
  }
}
