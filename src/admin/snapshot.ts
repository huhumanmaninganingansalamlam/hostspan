import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../config/loader.js";
import type { Capability, HostSpanConfig } from "../config/schema.js";
import { writeConfigAtomic } from "../config/writer.js";
import { TmuxTerminalManager } from "../processes/tmux-terminal.js";
import { TargetRegistry } from "../targets/registry.js";
import { daemonStatus } from "../cli/daemon.js";
import { SERVER_VERSION, TOOLSET_VERSION } from "../version.js";

export interface AdminSnapshotOptions {
  recent?: number;
}

export interface AddWorkspaceInput {
  target_id?: string;
  label?: string;
  root: string;
  capabilities: Capability[];
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

function defaultExecProfile(config: HostSpanConfig): string | undefined {
  if (config.exec_profiles["native-dev"]?.mode === "native") return "native-dev";
  return Object.entries(config.exec_profiles).find(([, profile]) => profile.mode === "native")?.[0];
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
  const execProfile = capabilities.includes("exec") ? defaultExecProfile(config) : undefined;
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
    const db = new Database(statePath, { readonly: true, fileMustExist: true });
    try {
      const active = (
        db
          .prepare("SELECT count(*) AS count FROM processes WHERE target_id=? AND state IN ('accepted','launching','running')")
          .get(targetId) as { count: number }
      ).count;
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
  let activeProcessCount = 0;

  if (existsSync(statePath)) {
    const db = new Database(statePath, { readonly: true, fileMustExist: true });
    try {
      const schema = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
      schemaVersion = schema ? Number(schema.value) : null;
      const calls = db
        .prepare(
          `SELECT request_id,event_type,metadata_json,timestamp
           FROM audit_events
           WHERE event_type IN ('request.accepted','response.returned','request.aborted')
           ORDER BY timestamp DESC
           LIMIT ?`,
        )
        .all(recent) as Array<{ request_id: string; event_type: string; metadata_json: string; timestamp: string }>;
      recentCalls = calls.map((row) => ({
        request_id: row.request_id,
        event_type: row.event_type,
        timestamp: row.timestamp,
        metadata: JSON.parse(row.metadata_json),
      }));
      const unmatched = db
        .prepare(
          `SELECT a.request_id,a.metadata_json,a.timestamp
           FROM audit_events a
           WHERE a.event_type='request.accepted'
             AND NOT EXISTS (
               SELECT 1 FROM audit_events done
               WHERE done.request_id=a.request_id
                 AND done.event_type IN ('response.returned','request.aborted')
             )
           ORDER BY a.timestamp DESC
           LIMIT 100`,
        )
        .all() as Array<{ request_id: string; metadata_json: string; timestamp: string }>;
      const activeCutoff = Date.now() - 5 * 60_000;
      activeRequests = unmatched
        .filter((row) => new Date(row.timestamp).getTime() >= activeCutoff)
        .map((row) => ({ request_id: row.request_id, timestamp: row.timestamp, metadata: JSON.parse(row.metadata_json) }));
      const processProjection =
        (schemaVersion ?? 0) >= 4
          ? "process_id,target_id,backend,backend_ref,state,started_at,ended_at,reason"
          : "process_id,target_id,'native' AS backend,NULL AS backend_ref,state,started_at,ended_at,reason";
      recentProcesses = db
        .prepare(
          `SELECT ${processProjection}
           FROM processes
           ORDER BY COALESCE(started_at,ended_at) DESC
           LIMIT ?`,
        )
        .all(recent) as Array<Record<string, unknown>>;
      activeProcesses = db
        .prepare(
          `SELECT ${processProjection}
           FROM processes
           WHERE state IN ('accepted','launching','running')
           ORDER BY started_at DESC`,
        )
        .all() as Array<Record<string, unknown>>;
      activeProcessCount = (
        db.prepare("SELECT count(*) AS count FROM processes WHERE state IN ('accepted','launching','running')").get() as { count: number }
      ).count;
    } finally {
      db.close();
    }
  }

  const terminal = config.terminal ? new TmuxTerminalManager(config.server.data_dir, config.terminal) : undefined;
  const terminalSessions = recentProcesses
    .filter((record) => record.backend === "tmux")
    .map((record) => {
      const session = typeof record.backend_ref === "string" ? record.backend_ref : null;
      const live = terminal && session ? terminal.inspectSync(session) : undefined;
      return {
        ...record,
        live: live?.exists ?? false,
        dead: live?.dead ?? null,
        ...(terminal && session
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
      git_repository: target.git_repository,
    })),
    terminal: {
      configured: Boolean(config.terminal),
      backend: config.terminal?.backend ?? null,
      sessions: terminalSessions,
    },
    state: { database_path: statePath, schema_version: schemaVersion },
    active_process_count: activeProcessCount,
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
  const db = new Database(statePath, { readonly: true, fileMustExist: true });
  try {
    const schema = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
    if (!schema || Number(schema.value) < 4) return null;
    const row = db
      .prepare("SELECT backend_ref,target_id,state FROM processes WHERE process_id=? AND backend='tmux'")
      .get(processId) as { backend_ref: string | null; target_id: string; state: string } | undefined;
    if (!row?.backend_ref) return null;
    return { session: row.backend_ref, target_id: row.target_id, state: row.state };
  } finally {
    db.close();
  }
}
