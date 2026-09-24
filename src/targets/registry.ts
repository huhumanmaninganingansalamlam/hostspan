import { existsSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Capability, HostSpanConfig, TargetConfig } from "../config/schema.js";
import { HostSpanError } from "../errors.js";

export interface TargetRuntime extends TargetConfig {
  target_id: string;
  root_real: string;
  root_dev: string | null;
  root_ino: string | null;
  ready: boolean;
}

export class TargetRegistry {
  private readonly targets = new Map<string, TargetRuntime>();

  constructor(config: HostSpanConfig) {
    for (const [targetId, target] of Object.entries(config.targets)) {
      const ready = existsSync(target.root) && statSync(target.root).isDirectory();
      const rootReal = ready ? realpathSync(target.root) : target.root;
      const rootStat = ready ? statSync(rootReal, { bigint: true }) : undefined;
      this.targets.set(targetId, {
        ...target,
        capabilities: [...target.capabilities],
        target_id: targetId,
        root_real: rootReal,
        root_dev: rootStat?.dev.toString() ?? null,
        root_ino: rootStat?.ino.toString() ?? null,
        ready,
      });
    }
  }

  list(): TargetRuntime[] {
    return [...this.targets.values()].sort((a, b) => a.target_id.localeCompare(b.target_id));
  }

  get(targetId: string, capability?: Capability): TargetRuntime {
    const target = this.targets.get(targetId);
    if (!target) throw new HostSpanError("TARGET_NOT_FOUND", `Unknown target_id: ${targetId}`);
    if (!target.ready) throw new HostSpanError("TARGET_NOT_READY", `Target is not ready: ${targetId}`, true);
    if (capability && !target.capabilities.includes(capability)) throw new HostSpanError("SCOPE_DENIED", `Target ${targetId} does not allow ${capability}.`);
    return target;
  }

  fingerprint(target: TargetRuntime): string {
    return `sha256:${createHash("sha256")
      .update(`${target.root_real}\0${target.root_dev ?? ""}\0${target.root_ino ?? ""}`)
      .digest("hex")}`;
  }
}
