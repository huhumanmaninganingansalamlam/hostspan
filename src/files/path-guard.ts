import { constants, lstatSync, openSync, closeSync, statSync, fstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HostSpanError } from "../errors.js";
import { resolveTargetPath, type GuardedPath } from "../targets/path.js";
import type { TargetRuntime } from "../targets/registry.js";
import { darwinOpenAt } from "./darwin-fs.js";
import {
  closeWindowsDirectoryGuard,
  openWindowsDirectoryGuard,
  type WindowsDirectoryGuard,
} from "./windows-fs.js";

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

export function openDirectoryNoFollow(target: TargetRuntime, input: string): OpenedDirectory {
  const guarded = resolveTargetPath(target, input);
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
      const rechecked = resolveTargetPath(target, input);
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
    const rechecked = resolveTargetPath(target, input);
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

export function assertDirectoryStillCurrent(target: TargetRuntime, input: string, openedDirectory: OpenedDirectory): void {
  const rechecked = resolveTargetPath(target, input);
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
  const guarded = resolveTargetPath(target, input);
  if (!guarded.exists) throw new HostSpanError("FILE_NOT_FOUND", `File does not exist: ${input}`);
  const parentRelative = dirname(guarded.relative);
  const parent = openDirectoryNoFollow(target, parentRelative);
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
      const rechecked = resolveTargetPath(target, input);
      assertDirectoryStillCurrent(target, parentRelative, parent);
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
