import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { HostSpanError } from "../errors.js";
import type { TargetRuntime } from "./registry.js";

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

export function resolveTargetPath(target: TargetRuntime, input: string): GuardedPath {
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
