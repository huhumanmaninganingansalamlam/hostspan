import { lstatSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { PolicyEvaluator } from "../policy/evaluator.js";
import type { TargetRuntime } from "../targets/registry.js";
import { resolveTargetPath } from "./path-guard.js";

export interface FileListInput {
  path: string;
  depth: number;
  max_entries: number;
  include_hidden: boolean;
  cursor?: string | undefined;
}

function cursorOffset(cursor?: string): number {
  if (!cursor) return 0;
  const parsed = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function ignored(target: TargetRuntime, rel: string): boolean {
  const segments = rel.replaceAll("\\", "/").split("/");
  if (segments.some((item) => [".git", "node_modules", "dist", ".cache"].includes(item))) return true;
  return target.ignore_globs.some((glob) => {
    const simple = glob.replace(/^\*\*\//, "").replace(/\/\*\*$/, "");
    return simple && segments.includes(simple);
  });
}

export function fileList(target: TargetRuntime, input: FileListInput, policy?: PolicyEvaluator) {
  const root = resolveTargetPath(target, input.path, "list");
  policy?.assertFileAllowed(target, root.relative, root.absolute, false);
  const entries: Array<Record<string, unknown>> = [];
  const walk = (dir: string, currentDepth: number): void => {
    for (const name of readdirSync(dir).sort()) {
      if (!input.include_hidden && name.startsWith(".")) continue;
      const absolute = resolve(dir, name);
      const rel = relative(target.root_real, absolute).replaceAll("\\", "/");
      if (ignored(target, rel)) continue;
      try {
        policy?.assertFileAllowed(target, rel, absolute, false);
      } catch {
        continue;
      }
      const stat = lstatSync(absolute);
      const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
      entries.push({ path: rel, type, size_bytes: stat.size, mtime: stat.mtime.toISOString() });
      if (type === "directory" && currentDepth < input.depth) walk(absolute, currentDepth + 1);
    }
  };
  const stat = lstatSync(root.absolute);
  if (stat.isDirectory()) walk(root.absolute, 1);
  else entries.push({ path: root.relative, type: stat.isFile() ? "file" : "other", size_bytes: stat.size, mtime: stat.mtime.toISOString() });
  const offset = cursorOffset(input.cursor);
  const page = entries.slice(offset, offset + input.max_entries);
  const next = offset + page.length;
  return {
    path: root.relative,
    entries: page,
    truncated: next < entries.length,
    ...(next < entries.length ? { cursor: Buffer.from(String(next)).toString("base64url") } : {}),
  };
}
