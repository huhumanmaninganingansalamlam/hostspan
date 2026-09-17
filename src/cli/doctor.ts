import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/loader.js";
import type { HostSpanConfig } from "../config/schema.js";
import { databaseHealthy, openDatabase } from "../state/database.js";
import { TargetRegistry } from "../targets/registry.js";
import { TOOL_NAMES, TOOLSET_HASH } from "../mcp/registry.js";
import { PROTOCOL_VERSION, SERVER_VERSION } from "../version.js";

export interface DoctorCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  details: string;
}

export interface DoctorReport {
  ok: boolean;
  server_version: string;
  protocol_version: string;
  toolset_hash: string;
  checks: DoctorCheck[];
}

function commandCheck(command: string, args: string[]): DoctorCheck {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return { name: command, status: "fail", details: result.error?.message ?? result.stderr?.trim() ?? `${command} exited ${result.status}` };
  }
  return { name: command, status: "pass", details: result.stdout.trim().split("\n")[0] ?? "available" };
}

async function processGroupCheck(): Promise<DoctorCheck> {
  if (process.platform !== "linux") return { name: "process_group", status: "fail", details: "Alpha requires Linux/WSL2 process-group semantics." };
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  if (!pid) return { name: "process_group", status: "fail", details: "spawn did not return a PID" };
  try {
    process.kill(-pid, "SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      process.kill(-pid, 0);
      process.kill(-pid, "SIGKILL");
      return { name: "process_group", status: "fail", details: "process group remained alive after SIGTERM" };
    } catch {
      return { name: "process_group", status: "pass", details: "detached process group spawn/TERM/reap succeeded" };
    }
  } finally {
    child.unref();
  }
}

export async function runDoctor(configPath: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    status: nodeMajor >= 22 ? "pass" : "fail",
    details: `${process.version} (${process.platform}/${process.arch})`,
  });
  checks.push({
    name: "platform",
    status: process.platform === "linux" && process.arch === "x64" ? "pass" : "fail",
    details: "Alpha supports Linux x64 (Ubuntu 24.04 LTS or WSL2).",
  });
  checks.push(commandCheck("rg", ["--version"]));
  checks.push(commandCheck("git", ["--version"]));

  let config: HostSpanConfig;
  try {
    config = loadConfig(configPath);
    const mode = statSync(configPath).mode & 0o777;
    checks.push({
      name: "config",
      status: (mode & 0o077) === 0 ? "pass" : "warn",
      details: `schema valid; mode=${mode.toString(8)}${(mode & 0o077) === 0 ? "" : " (recommend 600)"}`,
    });
  } catch (error) {
    checks.push({ name: "config", status: "fail", details: error instanceof Error ? error.message : String(error) });
    return { ok: false, server_version: SERVER_VERSION, protocol_version: PROTOCOL_VERSION, toolset_hash: TOOLSET_HASH, checks };
  }

  const targets = new TargetRegistry(config);
  for (const target of targets.list()) {
    checks.push({
      name: `target:${target.target_id}`,
      status: target.ready ? "pass" : "fail",
      details: target.ready ? `provider=${target.provider}; capabilities=${target.capabilities.join(",")}` : "target root is unavailable",
    });
  }

  try {
    const db = openDatabase(join(config.server.data_dir, "state.db"));
    checks.push({ name: "sqlite", status: databaseHealthy(db) ? "pass" : "fail", details: "integrity_check + WAL" });
    db.close();
  } catch (error) {
    checks.push({ name: "sqlite", status: "fail", details: error instanceof Error ? error.message : String(error) });
  }

  try {
    const spoolDir = join(config.server.data_dir, "spools");
    mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    const probe = join(spoolDir, `.doctor-${process.pid}`);
    writeFileSync(probe, "ok", { mode: 0o600 });
    const fd = openSync(probe, "r");
    closeSync(fd);
    rmSync(probe, { force: true });
    checks.push({ name: "spool", status: "pass", details: "state spool is writable" });
  } catch (error) {
    checks.push({ name: "spool", status: "fail", details: error instanceof Error ? error.message : String(error) });
  }

  checks.push(await processGroupCheck());
  checks.push({
    name: "toolset",
    status: TOOL_NAMES.length === 10 ? "pass" : "fail",
    details: `${TOOL_NAMES.length} tools; ${TOOLSET_HASH}`,
  });
  const tunnel = spawnSync("tunnel-client", ["--version"], { encoding: "utf8" });
  checks.push({
    name: "tunnel-client",
    status: tunnel.status === 0 ? "pass" : "warn",
    details: tunnel.status === 0 ? tunnel.stdout.trim().split("\n")[0] ?? "available" : "optional check: tunnel-client not found on PATH",
  });
  const cloudflared = spawnSync("cloudflared", ["--version"], { encoding: "utf8" });
  checks.push({
    name: "cloudflared",
    status: cloudflared.status === 0 ? "pass" : "warn",
    details:
      cloudflared.status === 0
        ? cloudflared.stdout.trim().split("\n")[0] ?? "available"
        : "optional check: cloudflared not found; required only for `hostspan expose` Quick Tunnel mode",
  });
  return {
    ok: checks.every((check) => check.status !== "fail"),
    server_version: SERVER_VERSION,
    protocol_version: PROTOCOL_VERSION,
    toolset_hash: TOOLSET_HASH,
    checks,
  };
}
