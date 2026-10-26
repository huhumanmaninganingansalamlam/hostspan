import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInitialConfig } from "../config/defaults.js";
import { loadConfig } from "../config/loader.js";
import { defaultConfigPath } from "../config/paths.js";
import { writeConfigAtomic } from "../config/writer.js";

export function ensureDesktopConfig(configPath: string): { created: boolean; config_path: string } {
  if (existsSync(configPath)) return { created: false, config_path: configPath };
  writeConfigAtomic(configPath, createInitialConfig());
  return { created: true, config_path: configPath };
}

export function prepareDesktopConfig(userDataDir: string): string {
  const selectionPath = join(userDataDir, "config-path");
  const remembered = existsSync(selectionPath) ? readFileSync(selectionPath, "utf8").trim() : undefined;
  const configPath = resolve(process.env.HOSTSPAN_CONFIG || remembered || defaultConfigPath());
  ensureDesktopConfig(configPath);
  loadConfig(configPath);
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const temp = `${selectionPath}.tmp-${process.pid}`;
  writeFileSync(temp, `${configPath}\n`, { mode: 0o600 });
  renameSync(temp, selectionPath);
  return configPath;
}
