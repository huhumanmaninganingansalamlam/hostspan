import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { HostSpanConfigSchema, type HostSpanConfig } from "./schema.js";

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadConfig(path: string): HostSpanConfig {
  const raw = parseYaml(readFileSync(path, "utf8"));
  if (raw && typeof raw === "object" && "terminal" in raw) {
    const terminal = (raw as { terminal?: unknown }).terminal;
    if (terminal && typeof terminal === "object") {
      const legacy = terminal as { backend?: unknown; history_limit_lines?: unknown };
      if (legacy.backend === "tmux") legacy.backend = "pty";
      delete legacy.history_limit_lines;
    }
  }
  const config = HostSpanConfigSchema.parse(raw);
  const targets = Object.fromEntries(
    Object.entries(config.targets).map(([targetId, target]) => {
      const root = expandHome(target.root);
      if (!isAbsolute(root)) throw new Error(`target ${targetId} root must be absolute`);
      return [targetId, { ...target, root: resolve(root) }];
    }),
  );
  return {
    ...config,
    server: { ...config.server, data_dir: resolve(expandHome(config.server.data_dir)) },
    targets,
  };
}
