import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/loader.js";
import type { HostSpanConfig } from "../config/schema.js";
import { databaseHealthy, openMemoryDatabase, openReadOnlyDatabase } from "../state/database.js";
import { TargetRegistry } from "../targets/registry.js";
import { TOOL_NAMES, TOOLSET_HASH } from "../mcp/registry.js";
import { processGroupAlive, signalProcessGroup } from "../processes/recovery.js";
import { windowsJobObjectProbe } from "../processes/windows-job-process.js";
import { ripgrepExecutable } from "../files/ripgrep.js";
import { inspectWindowsAcl, protectWindowsDirectory } from "../security/windows-acl.js";
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

function commandCheck(command: string, args: string[], name = command): DoctorCheck {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
  if (result.error || result.status !== 0) {
    return { name, status: "fail", details: result.error?.message ?? result.stderr?.trim() ?? `${command} exited ${result.status}` };
  }
  return { name, status: "pass", details: result.stdout.trim().split("\n")[0] ?? "available" };
}

function ptyRuntimeCheck(): DoctorCheck {
  if (!(["linux", "darwin", "win32"] as NodeJS.Platform[]).includes(process.platform)) {
    return { name: "pty_runtime", status: "fail", details: `PTY runtime is unsupported on ${process.platform}.` };
  }
  const nodePtyUrl = pathToFileURL(createRequire(import.meta.url).resolve("node-pty")).href;
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(nodePtyUrl)}).then(m=>process.exit(typeof m.spawn==='function'?0:2)).catch(error=>{console.error(error?.stack||String(error));process.exit(1)})`,
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    },
  );
  return {
    name: "pty_runtime",
    status: result.status === 0 ? "pass" : "fail",
    details: result.status === 0 ? `node-pty available (${process.platform}/${process.arch})` : result.stderr?.trim() || "node-pty could not be loaded",
  };
}

async function processGroupCheck(): Promise<DoctorCheck> {
  if (process.platform !== "linux" && process.platform !== "darwin" && process.platform !== "win32") {
    return { name: "process_tree", status: "fail", details: `Native process-tree control is not qualified on ${process.platform}.` };
  }
  if (process.platform === "win32") {
    const probe = windowsJobObjectProbe();
    return { name: "process_tree", status: probe.ok ? "pass" : "fail", details: probe.details };
  }
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  if (!pid) return { name: "process_tree", status: "fail", details: "spawn did not return a PID" };
  try {
    signalProcessGroup(pid, "SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if (processGroupAlive(pid)) {
      signalProcessGroup(pid, "SIGKILL");
      return { name: "process_tree", status: "fail", details: "process tree remained alive after termination" };
    }
    return {
      name: "process_tree",
      status: "pass",
      details: "detached process group spawn/TERM/reap succeeded",
    };
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
    status:
      ((process.platform === "linux" || process.platform === "win32") && process.arch === "x64") ||
      (process.platform === "darwin" && (process.arch === "x64" || process.arch === "arm64"))
        ? "pass"
        : "fail",
    details: "Qualified core targets are Linux x64, native Windows x64, and macOS x64/arm64; WSL2 is treated as Linux.",
  });
  checks.push(commandCheck(ripgrepExecutable(), ["--version"], "rg"));

  let config: HostSpanConfig;
  try {
    config = loadConfig(configPath);
    const mode = statSync(configPath).mode & 0o777;
    checks.push(
      process.platform === "win32"
        ? { name: "config", status: "warn", details: "schema valid; POSIX mode bits are not an authoritative Windows ACL check" }
        : {
            name: "config",
            status: (mode & 0o077) === 0 ? "pass" : "warn",
            details: `schema valid; mode=${mode.toString(8)}${(mode & 0o077) === 0 ? "" : " (recommend 600)"}`,
          },
    );
  } catch (error) {
    checks.push({ name: "config", status: "fail", details: error instanceof Error ? error.message : String(error) });
    return { ok: false, server_version: SERVER_VERSION, protocol_version: PROTOCOL_VERSION, toolset_hash: TOOLSET_HASH, checks };
  }

  const targets = new TargetRegistry(config);
  const nonLoopback = !["127.0.0.1", "localhost", "::1"].includes(config.server.listen_host.toLowerCase());
  checks.push({
    name: "network_bind",
    status: nonLoopback && !config.oauth ? "fail" : nonLoopback ? "warn" : "pass",
    details: nonLoopback
      ? `listen_host=${config.server.listen_host}; allowed_hosts=${(config.server.allowed_hosts ?? []).join(",") || "<derived>"}; protect non-loopback access with firewall/TLS/authentication as appropriate`
      : `listen_host=${config.server.listen_host}; loopback-only`,
  });
  if (config.oauth) {
    const publicUrl = new URL(config.oauth.public_mcp_url);
    const publicHostAllowed = (config.server.allowed_hosts ?? []).includes(publicUrl.hostname);
    checks.push({
      name: "oauth",
      status: publicHostAllowed ? "pass" : "fail",
      details: publicHostAllowed
        ? `issuer=${publicUrl.origin}; resource=${config.oauth.public_mcp_url}`
        : `public OAuth host ${publicUrl.hostname} is missing from server.allowed_hosts`,
    });
  } else {
    checks.push({
      name: "oauth",
      status: nonLoopback ? "fail" : "warn",
      details: nonLoopback
        ? "OAuth is required for non-loopback HostSpan."
        : "OAuth is not configured; acceptable only for local loopback use.",
    });
  }
  if (process.platform === "win32") {
    let stateAclCreationError: string | undefined;
    if (!existsSync(config.server.data_dir)) {
      try {
        protectWindowsDirectory(config.server.data_dir);
      } catch (error) {
        stateAclCreationError = error instanceof Error ? error.message : String(error);
      }
    }
    const aclChecks: Array<readonly [string, string]> = [
      ["config_acl", configPath],
      ["config_backup_acl", `${configPath}.bak`],
      ["state_acl", config.server.data_dir],
      ...(config.oauth
        ? ([["oauth_secret_acl", join(dirname(configPath), "oauth-approval-secret")]] as Array<
            readonly [string, string]
          >)
        : []),
    ];
    for (const [name, path] of aclChecks) {
      if (name === "state_acl" && stateAclCreationError) {
        checks.push({ name, status: "fail", details: stateAclCreationError });
        continue;
      }
      if (!existsSync(path)) {
        checks.push({
          name,
          status: "pass",
          details: `${path} does not exist yet; HostSpan applies a private DACL when it creates the path.`,
        });
        continue;
      }
      try {
        const acl = inspectWindowsAcl(path);
        checks.push({
          name,
          status: acl.private ? "pass" : "fail",
          details: acl.private
            ? `${path} allows only the current Windows user and LocalSystem`
            : [
                `${path} does not satisfy the private HostSpan DACL`,
                acl.unexpected_allow_sids.length
                  ? `unexpected allow principals=${acl.unexpected_allow_sids.join(",")}`
                  : "",
                acl.missing_full_control_sids.length
                  ? `missing FullControl=${acl.missing_full_control_sids.join(",")}`
                  : "",
                acl.deny_sids.length ? `deny principals=${acl.deny_sids.join(",")}` : "",
                acl.inherited_rule_count ? `inherited rules=${acl.inherited_rule_count}` : "",
              ]
                .filter(Boolean)
                .join("; "),
        });
      } catch (error) {
        checks.push({
          name,
          status: "fail",
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  for (const target of targets.list()) {
    checks.push({
      name: `target:${target.target_id}`,
      status: target.ready ? "pass" : "fail",
      details: target.ready ? `provider=${target.provider}; capabilities=${target.capabilities.join(",")}` : "target root is unavailable",
    });
  }
  if (config.terminal || targets.list().some((target) => target.capabilities.includes("terminal"))) {
    checks.push(ptyRuntimeCheck());
  }

  try {
    const statePath = join(config.server.data_dir, "state.db");
    const db = existsSync(statePath) ? openReadOnlyDatabase(statePath) : openMemoryDatabase();
    checks.push({
      name: "sqlite",
      status: databaseHealthy(db) ? "pass" : "fail",
      details: existsSync(statePath) ? "integrity_check + current schema (read-only)" : "SQLite binding OK; state database not created yet",
    });
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
  const tunnel = spawnSync("tunnel-client", ["--version"], { encoding: "utf8", timeout: 2_000, windowsHide: true });
  checks.push({
    name: "tunnel-client",
    status: tunnel.status === 0 ? "pass" : "warn",
    details: tunnel.status === 0 ? tunnel.stdout.trim().split("\n")[0] ?? "available" : "optional check: tunnel-client not found on PATH",
  });
  return {
    ok: checks.every((check) => check.status !== "fail"),
    server_version: SERVER_VERSION,
    protocol_version: PROTOCOL_VERSION,
    toolset_hash: TOOLSET_HASH,
    checks,
  };
}
