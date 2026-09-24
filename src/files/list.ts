import { lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { HostSpanError } from "../errors.js";
import type { PolicyEvaluator } from "../policy/evaluator.js";
import { matchesAnyPolicyGlob } from "../policy/glob.js";
import type { TargetRuntime } from "../targets/registry.js";
import { resolveTargetPath } from "../targets/path.js";
import { darwinReadDirectoryNames } from "./darwin-fs.js";
import {
  assertDirectoryStillCurrent,
  closeOpenedDirectory,
  openDirectoryNoFollow,
} from "./path-guard.js";

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
  return matchesAnyPolicyGlob(rel, target.ignore_globs);
}

export function fileList(target: TargetRuntime, input: FileListInput, policy?: PolicyEvaluator) {
  const root = resolveTargetPath(target, input.path);
  policy?.assertFileAllowed(target, root.relative, root.absolute, false);
  if (!root.exists) throw new HostSpanError("FILE_NOT_FOUND", `Path does not exist: ${input.path}`);
  const entries: Array<Record<string, unknown>> = [];
  const offset = cursorOffset(input.cursor);
  const collectLimit = offset + input.max_entries + 1;
  const walk = (relativeDir: string, currentDepth: number): boolean => {
    const opened = openDirectoryNoFollow(target, relativeDir);
    try {
      const enumerationPath = process.platform === "linux" ? opened.stable_path : opened.path.absolute;
      const names =
        process.platform === "darwin"
          ? (() => {
              if (opened.fd === null) throw new Error("Darwin directory handle is unavailable.");
              return darwinReadDirectoryNames(opened.fd).sort();
            })()
          : readdirSync(enumerationPath).sort();
      assertDirectoryStillCurrent(target, relativeDir, opened);
      for (const name of names) {
        if (!input.include_hidden && name.startsWith(".")) continue;
        const rel = (relativeDir === "." ? name : `${relativeDir.replaceAll("\\", "/")}/${name}`).replace(/^\.\//, "");
        if (ignored(target, rel)) continue;
        const absolute = resolve(target.root_real, rel);
        try {
          policy?.assertFileAllowed(target, rel, absolute, false);
        } catch {
          continue;
        }
        const entryPath = resolve(enumerationPath, name);
        const stat = lstatSync(entryPath);
        const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
        entries.push({ path: rel, type, size_bytes: stat.size, mtime: stat.mtime.toISOString() });
        if (entries.length >= collectLimit) {
          assertDirectoryStillCurrent(target, relativeDir, opened);
          return true;
        }
        if (type === "directory" && currentDepth < input.depth && walk(rel, currentDepth + 1)) {
          assertDirectoryStillCurrent(target, relativeDir, opened);
          return true;
        }
      }
      assertDirectoryStillCurrent(target, relativeDir, opened);
      return false;
    } finally {
      closeOpenedDirectory(opened);
    }
  };
  const stat = lstatSync(root.absolute);
  if (stat.isDirectory()) walk(root.relative, 1);
  else entries.push({ path: root.relative, type: stat.isFile() ? "file" : "other", size_bytes: stat.size, mtime: stat.mtime.toISOString() });
  const page = entries.slice(offset, offset + input.max_entries);
  const next = offset + page.length;
  return {
    path: root.relative,
    entries: page,
    truncated: entries.length > next,
    ...(entries.length > next ? { cursor: Buffer.from(String(next)).toString("base64url") } : {}),
  };
}
