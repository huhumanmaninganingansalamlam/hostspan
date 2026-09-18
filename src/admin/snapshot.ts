import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../config/loader.js";
import { TmuxTerminalManager } from "../processes/tmux-terminal.js";
import { TargetRegistry } from "../targets/registry.js";
import { daemonStatus } from "../cli/daemon.js";
import { SERVER_VERSION, TOOLSET_VERSION } from "../version.js";

export interface AdminSnapshotOptions {
  recent?: number;
}

export function buildAdminSnapshot(configPath: string, options: AdminSnapshotOptions = {}) {
  const resolvedConfigPath = resolve(configPath);
  const config = loadConfig(resolvedConfigPath);
  const targets = new TargetRegistry(config);
  const statePath = join(config.server.data_dir, "state.db");
  const recent = Math.max(1, Math.min(options.recent ?? 30, 200));
  let recentCalls: Array<Record<string, unknown>> = [];
  let recentProcesses: Array<Record<string, unknown>> = [];
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
