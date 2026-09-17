import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HostSpanConfig } from "../config/schema.js";
import type { AuditRepo } from "../state/audit-repo.js";
import type { ProcessesRepo } from "../state/processes-repo.js";
import type { TargetRegistry } from "../targets/registry.js";
import { SERVER_VERSION, TOOLSET_VERSION } from "../version.js";
import { TOOLSET_HASH } from "../mcp/registry.js";
import { redact } from "./redactor.js";

export interface SupportExportInput {
  config: HostSpanConfig;
  targets: TargetRegistry;
  audit: AuditRepo;
  processes: ProcessesRepo;
}

export function buildSupportExport(input: SupportExportInput): Record<string, unknown> {
  const payload = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    server_version: SERVER_VERSION,
    toolset_version: TOOLSET_VERSION,
    toolset_hash: TOOLSET_HASH,
    policy_epoch: input.config.policy_epoch,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      native_execution: true,
      sandboxed: false,
    },
    server: {
      listen_host: input.config.server.listen_host,
      listen_port: input.config.server.listen_port,
    },
    targets: input.targets.list().map((target) => ({
      target_id: target.target_id,
      label: target.label,
      provider: target.provider,
      capabilities: target.capabilities,
      exec_mode: target.exec_profile ? "native" : null,
      ready: target.ready,
      git_repository: target.git_repository,
    })),
    processes: input.processes.recent(200).map((record) => ({
      process_id: record.process_id,
      idempotency_key: record.idempotency_key,
      target_id: record.target_id,
      argv_digest: record.argv_digest,
      cwd_relative: record.cwd_relative,
      state: record.state,
      exit_code: record.exit_code,
      term_signal: record.term_signal,
      reason: record.reason,
      started_at: record.started_at,
      ended_at: record.ended_at,
      stdout_bytes: record.stdout_bytes,
      stderr_bytes: record.stderr_bytes,
    })),
    audit_events: input.audit.recent(500),
  };
  return redact(payload) as Record<string, unknown>;
}

export function writeSupportExportAtomic(path: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
