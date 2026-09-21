import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import koffi from "koffi";
import { resolveWindowsCommand } from "./windows-command.mjs";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

function lastErrorFunctions() {
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

if (process.argv.includes("--probe")) {
  createKillOnCloseJob();
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  process.stdout.write(`job-object-ok child=${child.pid}\n`);
} else {
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
