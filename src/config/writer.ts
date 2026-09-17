import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { HostSpanConfigSchema, type HostSpanConfig } from "./schema.js";

export function writeConfigAtomic(path: string, input: HostSpanConfig): void {
  const config = HostSpanConfigSchema.parse(input);
  const dir = dirname(path);
  const temp = `${path}.tmp-${process.pid}`;
  const backup = `${path}.bak`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if (existsSync(path)) copyFileSync(path, backup);
    writeFileSync(temp, stringifyYaml(config), { mode: 0o600 });
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } finally {
    rmSync(temp, { force: true });
  }
}
