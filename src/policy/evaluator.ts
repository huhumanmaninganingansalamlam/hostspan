import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ExecProfile, HostSpanConfig } from "../config/schema.js";
import { HostSpanError } from "../mcp/errors.js";
import type { TargetRuntime } from "../targets/registry.js";

function globRegex(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      pattern += ".*";
      i += 1;
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char?.replace(/[\\^$+?.()|{}[\]]/g, "\\$&") ?? "";
  }
  return new RegExp(`^${pattern}$`);
}

function canonicalPolicyPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (existsSync(parent)) return resolve(realpathSync(parent), basename(absolute));
  return absolute;
}

export class PolicyEvaluator {
  private readonly protectedPaths: Set<string>;

  constructor(private readonly config: HostSpanConfig, protectedPaths: string[] = []) {
    this.protectedPaths = new Set(protectedPaths.map(canonicalPolicyPath));
  }

  assertFileAllowed(target: TargetRuntime, relativePath: string, absolutePath: string, write = false): void {
    const normalized = relativePath.replaceAll("\\", "/");
    if (target.deny_globs.some((glob) => globRegex(glob).test(normalized))) {
      throw new HostSpanError("SCOPE_DENIED", `Path is denied by target policy: ${relativePath}`);
    }
    if (write && this.protectedPaths.has(canonicalPolicyPath(absolutePath))) {
      throw new HostSpanError("SCOPE_DENIED", "HostSpan admin configuration cannot be modified through MCP file tools.");
    }
  }

  execProfile(target: TargetRuntime): ExecProfile {
    if (!target.exec_profile) throw new HostSpanError("SCOPE_DENIED", `Target ${target.target_id} has no exec profile.`);
    const profile = this.config.exec_profiles[target.exec_profile];
    if (!profile) throw new HostSpanError("TARGET_NOT_READY", `Exec profile ${target.exec_profile} is not configured.`);
    if (profile.mode !== "native") throw new HostSpanError("POLICY_UNENFORCEABLE", "Alpha only supports native execution.");
    return profile;
  }

  validateExec(target: TargetRuntime, argv: string[], env: Record<string, string>, deadlineMs: number, maxOutputBytes: number): ExecProfile {
    const profile = this.execProfile(target);
    const program = argv[0];
    if (!program) {
      throw new HostSpanError("SCOPE_DENIED", "Process argv must include a program.");
    }
    const hasTerminalAuthority = target.capabilities.includes("terminal");
    if (!hasTerminalAuthority && (program.includes("/") || !profile.allowed_programs.includes(basename(program)))) {
      throw new HostSpanError("SCOPE_DENIED", `Program is not allowed by exec profile: ${program ?? "<missing>"}`);
    }
    if (!hasTerminalAuthority) {
      const deniedEnv = Object.keys(env).filter((key) => !profile.env_allowlist.includes(key));
      if (deniedEnv.length) throw new HostSpanError("SCOPE_DENIED", `Environment variables are not allowed: ${deniedEnv.join(", ")}`);
    }
    if (deadlineMs > profile.max_deadline_ms) throw new HostSpanError("SCOPE_DENIED", "deadline_ms exceeds exec profile maximum.");
    if (maxOutputBytes > profile.max_output_bytes) throw new HostSpanError("SCOPE_DENIED", "max_output_bytes exceeds exec profile maximum.");
    return profile;
  }
}
