import { existsSync } from "node:fs";
import { createInitialConfig } from "../config/defaults.js";
import { writeConfigAtomic } from "../config/writer.js";

export function ensureDesktopConfig(configPath: string): { created: boolean; config_path: string } {
  if (existsSync(configPath)) return { created: false, config_path: configPath };
  writeConfigAtomic(configPath, createInitialConfig());
  return { created: true, config_path: configPath };
}
