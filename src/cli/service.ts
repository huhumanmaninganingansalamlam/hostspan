import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function serviceExecutionPath(nodePath = process.execPath, inheritedPath = process.env.PATH ?? ""): string {
  const entries = [dirname(nodePath), ...inheritedPath.split(delimiter)].filter(Boolean);
  return [...new Set(entries)].join(delimiter);
}

function systemctl(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    output: (result.stdout || result.stderr || result.error?.message || "").trim(),
  };
}

export function serviceUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", "hostspan.service");
}

export function systemdServiceInstalled(unitPath = serviceUnitPath(), platform = process.platform): boolean {
  return platform === "linux" && existsSync(unitPath);
}

export function installSystemdService(configPath: string, cliPath = process.argv[1] ?? "hostspan"): { ok: boolean; unit_path: string; output: string } {
  if (process.platform !== "linux") return { ok: false, unit_path: serviceUnitPath(), output: "Alpha service management supports systemd on Linux/WSL2 only." };
  const unitPath = serviceUnitPath();
  mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
  const executable = cliPath === "hostspan" ? "hostspan" : resolve(cliPath);
  const unit = `[Unit]\nDescription=HostSpan MCP execution gateway\nAfter=network-online.target\n\n[Service]\nType=simple\nEnvironment=${systemdQuote(`PATH=${serviceExecutionPath()}`)}\nExecStart=${systemdQuote(process.execPath)} ${systemdQuote(executable)} serve --config ${systemdQuote(resolve(configPath))}\nRestart=on-failure\nRestartSec=2\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`;
  writeFileSync(unitPath, unit, { mode: 0o600 });
  chmodSync(unitPath, 0o600);
  const reload = systemctl(["daemon-reload"]);
  return { ok: reload.ok, unit_path: unitPath, output: reload.output || "installed" };
}

export function runServiceCommand(action: "start" | "stop" | "restart" | "status"): { ok: boolean; output: string } {
  const args = action === "status" ? ["status", "hostspan.service", "--no-pager"] : [action, "hostspan.service"];
  return systemctl(args);
}
