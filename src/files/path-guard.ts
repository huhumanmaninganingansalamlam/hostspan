import { constants, lstatSync, openSync, closeSync, realpathSync, existsSync, statSync, fstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { HostSpanError } from "../mcp/errors.js";
import type { TargetRuntime } from "../targets/registry.js";
import { darwinOpenAt } from "./darwin-fs.js";
import {
  closeWindowsDirectoryGuard,
  openWindowsDirectoryGuard,
  type WindowsDirectoryGuard,
} from "./windows-fs.js";

export type PathIntent = "list" | "read" | "search" | "write" | "exec";

export interface GuardedPath {
  relative: string;
  absolute: string;
  exists: boolean;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validateInput(path: string): string {
  if (path.includes("\0")) throw new HostSpanError("PATH_OUTSIDE_TARGET", "NUL bytes are not allowed in paths.");
  if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
    throw new HostSpanError("PATH_OUTSIDE_TARGET", "Absolute paths are not accepted; paths are relative to target root.");
  }
  if (process.platform === "win32") {
    const deviceName = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/i;
    for (const segment of path.replaceAll("\\", "/").split("/")) {
      if (!segment || segment === "." || segment === "..") continue;
      const hasReservedSyntax = Array.from(segment).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || '<>:"|?*'.includes(character);
      });
      if (hasReservedSyntax) {
        throw new HostSpanError("PATH_OUTSIDE_TARGET", `Windows-reserved path syntax is not allowed: ${segment}`);
      }
      if (/[. ]$/.test(segment)) {
        throw new HostSpanError("PATH_OUTSIDE_TARGET", `Windows paths may not end a segment with a dot or space: ${segment}`);
      }
      const baseName = segment.split(".", 1)[0] ?? segment;
      if (deviceName.test(baseName)) {
        throw new HostSpanError("PATH_OUTSIDE_TARGET", `Windows device names are not allowed in target paths: ${segment}`);
      }
    }
  }
  const normalized = normalize(path || ".");
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new HostSpanError("PATH_OUTSIDE_TARGET", "Path traversal outside the target root is not allowed.");
  }
  return normalized;
}

function verifiedRoot(target: TargetRuntime): string {
  let root: string;
  try {
    root = realpathSync(target.root_real);
  } catch {
    throw new HostSpanError("TARGET_NOT_READY", `Target root is no longer available: ${target.target_id}`, true);
  }
  if (root !== target.root_real) {
    throw new HostSpanError("TARGET_NOT_READY", `Target root canonical path changed: ${target.target_id}`, true);
  }
  const stat = statSync(root, { bigint: true });
  if (target.root_dev !== stat.dev.toString() || target.root_ino !== stat.ino.toString()) {
    throw new HostSpanError("TARGET_NOT_READY", `Target root identity changed: ${target.target_id}`, true);
  }
  return root;
}

export function resolveTargetPath(target: TargetRuntime, input: string, _intent: PathIntent): GuardedPath {
  const normalized = validateInput(input);
  const root = verifiedRoot(target);
  const absolute = resolve(root, normalized);
  if (!isContained(root, absolute)) throw new HostSpanError("PATH_OUTSIDE_TARGET", "Resolved path is outside the configured target root.");

  const relParts = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (const part of relParts) {
    current = resolve(current, part);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new HostSpanError("SYMLINK_REJECTED", `Symlink path component is not allowed: ${relative(root, current)}`);
    const real = realpathSync(current);
    if (!isContained(root, real)) throw new HostSpanError("PATH_OUTSIDE_TARGET", "Canonical path escapes the configured target root.");
  }
  return { relative: relative(root, absolute) || ".", absolute, exists: existsSync(absolute) };
}

export interface OpenedDirectory {
  fd: number | null;
  windows_guard?: WindowsDirectoryGuard;
  path: GuardedPath;
  stable_path: string;
  dev: string;
  ino: string;
}

function directoryHandlePath(fd: number): string {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  throw new HostSpanError("POLICY_UNENFORCEABLE", `No descriptor-relative directory path is available on ${process.platform}.`);
}

export function openDirectoryNoFollow(target: TargetRuntime, input: string, intent: PathIntent): OpenedDirectory {
  const guarded = resolveTargetPath(target, input, intent);
  if (!guarded.exists) throw new HostSpanError("FILE_NOT_FOUND", `Directory does not exist: ${input}`);
  if (!lstatSync(guarded.absolute).isDirectory()) throw new HostSpanError("FILE_NOT_FOUND", `Not a directory: ${input}`);
  if (process.platform === "win32") {
    let windowsGuard: WindowsDirectoryGuard | undefined;
    try {
      windowsGuard = openWindowsDirectoryGuard(guarded.absolute);
    } catch (error) {
      throw new HostSpanError(
        "POLICY_UNENFORCEABLE",
        `Could not pin Windows directory against path replacement: ${input}`,
        true,
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
    const before = statSync(guarded.absolute, { bigint: true });
    try {
      const rechecked = resolveTargetPath(target, input, intent);
      const current = statSync(rechecked.absolute, { bigint: true });
      if (before.dev !== current.dev || before.ino !== current.ino) {
        throw new HostSpanError("SYMLINK_REJECTED", `Directory identity changed during open: ${input}`);
      }
      return {
        fd: null,
        windows_guard: windowsGuard,
        path: rechecked,
        stable_path: rechecked.absolute,
        dev: current.dev.toString(),
        ino: current.ino.toString(),
      };
    } catch (error) {
      closeWindowsDirectoryGuard(windowsGuard);
      throw error;
    }
  }
  const fd = openSync(guarded.absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const rechecked = resolveTargetPath(target, input, intent);
    const opened = fstatSync(fd, { bigint: true });
    const current = statSync(rechecked.absolute, { bigint: true });
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new HostSpanError("SYMLINK_REJECTED", `Directory identity changed during open: ${input}`);
    }
    return {
      fd,
      path: rechecked,
      stable_path: process.platform === "linux" ? directoryHandlePath(fd) : rechecked.absolute,
      dev: opened.dev.toString(),
      ino: opened.ino.toString(),
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function assertDirectoryStillCurrent(target: TargetRuntime, input: string, openedDirectory: OpenedDirectory, intent: PathIntent): void {
  const rechecked = resolveTargetPath(target, input, intent);
  const current = statSync(rechecked.absolute, { bigint: true });
  const opened =
    openedDirectory.fd === null
      ? { dev: openedDirectory.dev, ino: openedDirectory.ino }
      : (() => {
          const stat = fstatSync(openedDirectory.fd, { bigint: true });
          return { dev: stat.dev.toString(), ino: stat.ino.toString() };
        })();
  if (opened.dev !== current.dev.toString() || opened.ino !== current.ino.toString()) {
    throw new HostSpanError("SYMLINK_REJECTED", `Directory identity changed while operating on: ${input}`);
  }
}

export function closeOpenedDirectory(openedDirectory: OpenedDirectory): void {
  if (openedDirectory.fd !== null) closeSync(openedDirectory.fd);
  closeWindowsDirectoryGuard(openedDirectory.windows_guard);
}

export function openReadNoFollow(
  target: TargetRuntime,
  input: string,
  afterParentOpen?: () => void,
): { fd: number; path: GuardedPath } {
  const guarded = resolveTargetPath(target, input, "read");
  if (!guarded.exists) throw new HostSpanError("FILE_NOT_FOUND", `File does not exist: ${input}`);
  const parentRelative = dirname(guarded.relative);
  const parent = openDirectoryNoFollow(target, parentRelative, "read");
  try {
    afterParentOpen?.();
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const fd =
      process.platform === "darwin"
        ? (() => {
            if (parent.fd === null) throw new HostSpanError("POLICY_UNENFORCEABLE", "Darwin directory handle is unavailable.");
            return darwinOpenAt(parent.fd, basename(guarded.relative), flags);
          })()
        : openSync(process.platform === "win32" ? guarded.absolute : join(parent.stable_path, basename(guarded.relative)), flags);
    try {
      const rechecked = resolveTargetPath(target, input, "read");
      assertDirectoryStillCurrent(target, parentRelative, parent, "read");
      const opened = fstatSync(fd, { bigint: true });
      const current = statSync(rechecked.absolute, { bigint: true });
      if (opened.dev !== current.dev || opened.ino !== current.ino) {
        throw new HostSpanError("SYMLINK_REJECTED", `File identity changed during open: ${input}`);
      }
      return { fd, path: rechecked };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  } finally {
    closeOpenedDirectory(parent);
  }
}

export function recheckTargetPath(target: TargetRuntime, input: string, intent: PathIntent): GuardedPath {
  return resolveTargetPath(target, input, intent);
}
