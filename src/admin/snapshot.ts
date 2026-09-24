import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createNativeExecProfile } from "../config/defaults.js";
import { loadConfig } from "../config/loader.js";
import type { Capability, HostSpanConfig } from "../config/schema.js";
import { writeConfigAtomic } from "../config/writer.js";
import { processOutputActivity } from "../processes/output-spool.js";
import { PtySessionManager } from "../processes/pty-session.js";
import { AuditRepo } from "../state/audit-repo.js";
import { DB_SCHEMA_VERSION, openReadOnlyDatabase } from "../state/database.js";
import { ProcessesRepo } from "../state/processes-repo.js";
import { TargetRegistry } from "../targets/registry.js";
import { daemonStatus } from "../daemon/control.js";
import { SERVER_VERSION, TOOLSET_VERSION } from "../version.js";

export interface AdminSnapshotOptions {
  recent?: number;
}

export interface AddWorkspaceInput {
  target_id?: string;
  label?: string;
  root: string;
  capabilities: Capability[];
  exec_profile?: string;
}

const TARGET_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function workspaceTargetIdBase(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64);
  return slug || "workspace";
}

export function uniqueWorkspaceTargetId(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const normalized = workspaceTargetIdBase(base);
  if (!taken.has(normalized)) return normalized;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${normalized.slice(0, Math.max(1, 64 - tail.length))}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("could not generate a unique target_id for this workspace");
}

function normalizedCapabilities(input: Capability[]): Capability[] {
  const capabilities = [...new Set(input)];
  if (capabilities.includes("terminal") && !capabilities.includes("exec")) capabilities.push("exec");
  return capabilities;
}

function defaultExecProfile(config: HostSpanConfig): string {
  const existing = config.exec_profiles["native-dev"] ? "native-dev" : Object.keys(config.exec_profiles)[0];
  if (existing) return existing;
  config.exec_profiles["native-dev"] = createNativeExecProfile();
  return "native-dev";
}

export function addLocalWorkspace(configPath: string, input: AddWorkspaceInput) {
  const resolvedConfigPath = resolve(configPath);
  const config = loadConfig(resolvedConfigPath);
  const requestedRoot = resolve(input.root);
  if (!existsSync(requestedRoot) || !statSync(requestedRoot).isDirectory()) throw new Error("workspace folder does not exist.");
  const root = realpathSync(requestedRoot);
  const duplicate = Object.entries(config.targets).find(([, target]) => {
    try {
      return realpathSync(target.root) === root;
    } catch {
      return resolve(target.root) === root;
    }
  });
  if (duplicate) throw new Error(`workspace folder is already registered as ${duplicate[0]}`);

  const requestedTargetId = input.target_id?.trim() ?? "";
  if (requestedTargetId && !TARGET_ID.test(requestedTargetId)) {
    throw new Error("target_id must use 1-64 lowercase letters, numbers, dot, underscore, or dash.");
  }
  const targetId = requestedTargetId
    ? requestedTargetId
    : uniqueWorkspaceTargetId(basename(root), Object.keys(config.targets));
  if (config.targets[targetId]) throw new Error(`target already exists: ${targetId}`);

  const capabilities = normalizedCapabilities(input.capabilities);
  if (capabilities.length === 0) throw new Error("select at least one workspace capability.");
  if (input.exec_profile && !capabilities.includes("exec")) {
    throw new Error("exec_profile requires the exec capability.");
  }
  const requestedExecProfile = input.exec_profile?.trim();
  if (requestedExecProfile) {
    const profile = config.exec_profiles[requestedExecProfile];
    if (!profile || profile.mode !== "native") throw new Error(`unknown native exec profile: ${requestedExecProfile}`);
  }
  const execProfile = capabilities.includes("exec") ? requestedExecProfile || defaultExecProfile(config) : undefined;
  if (capabilities.includes("exec") && !execProfile) throw new Error("no native exec profile is configured.");

  config.targets[targetId] = {
    label: input.label?.trim() || basename(root) || targetId,
    provider: "local",
    root,
    capabilities,
    ...(execProfile ? { exec_profile: execProfile } : {}),
    deny_globs: ["**/.env*", "**/*.pem", "**/*.key", ".git/objects/**"],
    ignore_globs: ["**/node_modules/**", "**/dist/**", "**/.cache/**"],
  };
  config.policy_epoch += 1;
  writeConfigAtomic(resolvedConfigPath, config);
  return { ok: true, target_id: targetId, root, capabilities, policy_epoch: config.policy_epoch, restart_required: true };
}

export function removeLocalWorkspace(configPath: string, targetId: string) {
  const resolvedConfigPath = resolve(configPath);
  const config = loadConfig(resolvedConfigPath);
  if (!config.targets[targetId]) throw new Error(`unknown target: ${targetId}`);
  const statePath = join(config.server.data_dir, "state.db");
  if (existsSync(statePath)) {
    const db = openReadOnlyDatabase(statePath);
    try {
      const active = new ProcessesRepo(db).activeCountForTarget(targetId);
      if (active > 0) throw new Error(`cannot remove ${targetId} while ${active} process(es) are active`);
    } finally {
      db.close();
    }
  }
  delete config.targets[targetId];
  config.policy_epoch += 1;
  writeConfigAtomic(resolvedConfigPath, config);
  return { ok: true, target_id: targetId, policy_epoch: config.policy_epoch, restart_required: true };
}

export function buildAdminSnapshot(configPath: string, options: AdminSnapshotOptions = {}) {
  const resolvedConfigPath = resolve(configPath);
  const config = loadConfig(resolvedConfigPath);
  const targets = new TargetRegistry(config);
  const statePath = join(config.server.data_dir, "state.db");
  const recent = Math.max(1, Math.min(options.recent ?? 30, 200));
  let recentCalls: Array<Record<string, unknown>> = [];
  let recentProcesses: Array<Record<string, unknown>> = [];
  let activeRequests: Array<Record<string, unknown>> = [];
  let activeProcesses: Array<Record<string, unknown>> = [];
  let schemaVersion: number | null = null;

  if (existsSync(statePath)) {
    const db = openReadOnlyDatabase(statePath);
    try {
      schemaVersion = DB_SCHEMA_VERSION;
      const audit = new AuditRepo(db);
      const processes = new ProcessesRepo(db);
      recentCalls = audit.recentPerformanceEvents(recent).map((row) => ({
        request_id: row.request_id,
        event_type: row.event_type,
        timestamp: row.timestamp,
        metadata: row.metadata,
      }));
      const activeCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
      activeRequests = audit.activeRequests(activeCutoff);
      recentProcesses = processes.recentSummary(recent);
      activeProcesses = processes.activeSummary();
    } finally {
      db.close();
    }
  }

  const terminal = config.terminal ? new PtySessionManager(config.server.data_dir, config.terminal, { configPath: resolvedConfigPath }) : undefined;
  const terminalProcessRecords = new Map<string, Record<string, unknown>>();
  for (const record of [...activeProcesses, ...recentProcesses]) {
    if (record.backend !== "pty" || typeof record.process_id !== "string") continue;
    if (!terminalProcessRecords.has(record.process_id)) terminalProcessRecords.set(record.process_id, record);
  }
  const terminalSessions = [...terminalProcessRecords.values()].map((record) => {
    const processId = record.process_id as string;
    const session = typeof record.backend_ref === "string" ? record.backend_ref : null;
    const live = terminal && session ? terminal.inspectSync(session) : undefined;
    const output = processOutputActivity(config.server.data_dir, processId);
    return {
      ...record,
      ...output,
      live: live?.exists ?? false,
      dead: live?.dead ?? null,
      ...(terminal && session && live?.exists && !live.dead
        ? {
            attach_command: terminal.humanAttachCommand(session, false),
            attach_read_only_command: terminal.humanAttachCommand(session, true),
          }
        : {}),
    };
  });

  return {
    server_version: SERVER_VERSION,
    toolset_version: TOOLSET_VERSION,
    policy_epoch: config.policy_epoch,
    daemon: daemonStatus(resolvedConfigPath),
    listen: { host: config.server.listen_host, port: config.server.listen_port },
    targets: targets.list().map((target) => ({
      target_id: target.target_id,
      label: target.label,
      root: target.root_real,
      capabilities: target.capabilities,
      ready: target.ready,
    })),
    terminal: {
      configured: Boolean(config.terminal),
      backend: config.terminal?.backend ?? null,
      sessions: terminalSessions,
    },
    state: { database_path: statePath, schema_version: schemaVersion },
    active_process_count: activeProcesses.length,
    active_requests: activeRequests,
    active_processes: activeProcesses,
    recent_calls: recentCalls,
    recent_processes: recentProcesses,
  };
}

export function resolveTerminalSession(configPath: string, processId: string): { session: string; target_id: string; state: string } | null {
  const config = loadConfig(resolve(configPath));
  const statePath = join(config.server.data_dir, "state.db");
  if (!existsSync(statePath)) return null;
  const db = openReadOnlyDatabase(statePath);
  try {
    const row = new ProcessesRepo(db).terminalSession(processId);
    if (!row?.backend_ref) return null;
    return { session: row.backend_ref, target_id: row.target_id, state: row.state };
  } finally {
    db.close();
  }
}
