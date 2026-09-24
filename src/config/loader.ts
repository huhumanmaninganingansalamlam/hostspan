import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { HostSpanConfigSchema, type HostSpanConfig } from "./schema.js";

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadConfig(path: string): HostSpanConfig {
  const raw: unknown = parseYaml(readFileSync(path, "utf8"));
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
