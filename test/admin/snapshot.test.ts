import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { addLocalWorkspace, buildAdminSnapshot, removeLocalWorkspace } from "../../src/admin/snapshot.js";
import { daemonStatus, removeDaemonPid, writeDaemonPid } from "../../src/cli/daemon.js";
import { loadConfig } from "../../src/config/loader.js";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { AuditRepo } from "../../src/state/audit-repo.js";
import { openDatabase } from "../../src/state/database.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hostspan-admin-"));
  roots.push(root);
  const targetRoot = join(root, "target");
  const dataDir = join(root, "state");
  const configPath = join(root, "config.yaml");
  mkdirSync(targetRoot, { recursive: true });
  const config: HostSpanConfig = {
    schema_version: 1,
    policy_epoch: 9,
    server: { listen_host: "127.0.0.1", listen_port: 39393, data_dir: dataDir },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: 1024 * 1024,
    },
    terminal: { backend: "tmux", max_concurrent_sessions: 2, history_limit_lines: 10_000, max_output_bytes: 1024 * 1024 },
    targets: {
      local: {
        label: "Local workspace",
        provider: "local",
        root: targetRoot,
        capabilities: ["read", "write", "exec", "terminal"],
        exec_profile: "native",
        deny_globs: [],
        ignore_globs: [],
      },
    },
    exec_profiles: {
      native: {
        mode: "native",
        allowed_programs: ["node"],
        env_allowlist: [],
        default_deadline_ms: 30_000,
        max_deadline_ms: 60_000,
        default_output_bytes: 1024 * 1024,
        max_output_bytes: 8 * 1024 * 1024,
        max_concurrent_processes: 4,
      },
    },
  };
  writeConfigAtomic(configPath, config);
  return { root, targetRoot, configPath, dataDir };
}

describe("local admin snapshot", () => {
  it("reads targets, active work, calls, process state, and daemon pid without mutating running records", () => {
    const { configPath, dataDir } = fixture();
    const db = openDatabase(join(dataDir, "state.db"));
    const processes = new ProcessesRepo(db);
    processes.create({
      process_id: "proc_admin",
      idempotency_key: "0199e78d-4c00-7000-8000-000000000901",
      target_id: "local",
      argv_digest: "sha256:test",
      cwd_relative: ".",
      backend: "tmux",
      backend_ref: "hs-admin",
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      max_output_bytes: 1024 * 1024,
    });
    processes.markRunning("proc_admin", 12345, null);
    new AuditRepo(db).append({ request_id: "req_admin", event_type: "request.accepted", metadata: { tool: "system_status" } });
    db.close();
    writeDaemonPid(configPath, process.pid);

    try {
      const snapshot = buildAdminSnapshot(configPath, { recent: 20 });
      expect(snapshot.daemon).toMatchObject({ running: true, pid: process.pid });
      expect(snapshot.active_process_count).toBe(1);
      expect(snapshot.active_requests).toContainEqual(expect.objectContaining({ request_id: "req_admin" }));
      expect(snapshot.active_processes).toContainEqual(expect.objectContaining({ process_id: "proc_admin", target_id: "local" }));
      expect(snapshot.targets).toContainEqual(expect.objectContaining({ target_id: "local", label: "Local workspace", ready: true }));
      expect(snapshot.recent_calls).toContainEqual(expect.objectContaining({ request_id: "req_admin", event_type: "request.accepted" }));
      expect(snapshot.terminal.sessions).toContainEqual(expect.objectContaining({ process_id: "proc_admin", state: "running", live: false }));
      expect(() => removeLocalWorkspace(configPath, "local")).toThrow(/process\(es\) are active/);

      const readonly = new Database(join(dataDir, "state.db"), { readonly: true });
      try {
        expect((readonly.prepare("SELECT state FROM processes WHERE process_id=?").get("proc_admin") as { state: string }).state).toBe("running");
      } finally {
        readonly.close();
      }
    } finally {
      removeDaemonPid(configPath, process.pid);
    }
    expect(daemonStatus(configPath).running).toBe(false);
  });

  it("reads a pre-v4 database without triggering migration before the daemon starts", () => {
    const { configPath, dataDir } = fixture();
    const path = join(dataDir, "state.db");
    mkdirSync(dataDir, { recursive: true });
    rmSync(path, { force: true });
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key,value) VALUES('schema_version','3');
      CREATE TABLE processes (
        process_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, target_id TEXT NOT NULL,
        argv_digest TEXT NOT NULL, cwd_relative TEXT NOT NULL, pid INTEGER, pgid INTEGER,
        state TEXT NOT NULL, exit_code INTEGER, term_signal TEXT, reason TEXT,
        started_at TEXT, ended_at TEXT, stdout_bytes INTEGER NOT NULL DEFAULT 0,
        stderr_bytes INTEGER NOT NULL DEFAULT 0, output_expires_at TEXT
      );
      CREATE TABLE audit_events (
        event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, idempotency_key TEXT, process_id TEXT,
        event_type TEXT NOT NULL, metadata_json TEXT NOT NULL, timestamp TEXT NOT NULL
      );
      INSERT INTO processes(process_id,idempotency_key,target_id,argv_digest,cwd_relative,state,started_at)
      VALUES('proc_legacy','0199e78d-4c00-7000-8000-000000000902','local','sha256:test','.','running','2026-09-18T00:00:00.000Z');
    `);
    legacy.close();

    const snapshot = buildAdminSnapshot(configPath, { recent: 20 });
    expect(snapshot.state.schema_version).toBe(3);
    expect(snapshot.active_process_count).toBe(1);
    expect(snapshot.active_processes).toContainEqual(expect.objectContaining({ process_id: "proc_legacy", backend: "native" }));
    expect(snapshot.recent_processes).toContainEqual(
      expect.objectContaining({ process_id: "proc_legacy", backend: "native", backend_ref: null, state: "running" }),
    );

    const check = new Database(path, { readonly: true });
    try {
      const columns = check.prepare("PRAGMA table_info(processes)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "backend")).toBe(false);
      expect((check.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe("3");
    } finally {
      check.close();
    }
  });

  it("adds a local workspace with explicit capabilities and removes it safely", () => {
    const { root, configPath } = fixture();
    const workspace = join(root, "another-workspace");
    mkdirSync(workspace, { recursive: true });

    const added = addLocalWorkspace(configPath, {
      target_id: "another-workspace",
      label: "Another workspace",
      root: workspace,
      capabilities: ["read", "terminal"],
    });
    expect(added).toMatchObject({
      ok: true,
      target_id: "another-workspace",
      capabilities: ["read", "terminal", "exec"],
      restart_required: true,
    });

    const afterAdd = loadConfig(configPath);
    expect(afterAdd.targets["another-workspace"]).toMatchObject({
      label: "Another workspace",
      capabilities: ["read", "terminal", "exec"],
      exec_profile: "native",
    });

    const removed = removeLocalWorkspace(configPath, "another-workspace");
    expect(removed).toMatchObject({ ok: true, target_id: "another-workspace", restart_required: true });
    expect(loadConfig(configPath).targets["another-workspace"]).toBeUndefined();
  });

  it("rejects duplicate roots and invalid target ids", () => {
    const { root, targetRoot, configPath } = fixture();
    expect(() =>
      addLocalWorkspace(configPath, {
        target_id: "duplicate",
        root: targetRoot,
        capabilities: ["read"],
      }),
    ).toThrow(/already registered/);

    const unused = join(root, "unused");
    mkdirSync(unused, { recursive: true });
    expect(() =>
      addLocalWorkspace(configPath, {
        target_id: "Bad ID",
        root: unused,
        capabilities: ["read"],
      }),
    ).toThrow(/target_id/);
  });
});
