import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { addLocalWorkspace, buildAdminSnapshot, removeLocalWorkspace } from "../../src/admin/snapshot.js";
import {
  daemonStatus,
  removeDaemonPid,
  requestDaemonShutdown,
  startDaemonControlServer,
  stopDaemon,
  writeDaemonPid,
} from "../../src/cli/daemon.js";
import { loadConfig } from "../../src/config/loader.js";
import { runDoctor } from "../../src/cli/doctor.js";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { AuditRepo } from "../../src/state/audit-repo.js";
import { DB_SCHEMA_VERSION, openDatabase } from "../../src/state/database.js";
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
    terminal: { backend: "pty", max_concurrent_sessions: 2, attach_history_bytes: 64 * 1024, max_output_bytes: 1024 * 1024 },
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
  it("runs Doctor without creating or migrating the durable state database", async () => {
    const { configPath, dataDir } = fixture();
    const statePath = join(dataDir, "state.db");
    expect(existsSync(statePath)).toBe(false);
    const report = await runDoctor(configPath);
    expect(report.checks.find((check) => check.name === "sqlite")).toMatchObject({ status: "pass" });
    expect(existsSync(statePath)).toBe(false);
  });

  it("uses authenticated local IPC for graceful daemon shutdown requests", async () => {
    const { configPath } = fixture();
    let requested = false;
    const control = await startDaemonControlServer(configPath, () => {
      requested = true;
    });
    try {
      expect(await requestDaemonShutdown(configPath)).toEqual({ ok: true, pid: process.pid });
      await new Promise((resolve) => setImmediate(resolve));
      expect(requested).toBe(true);
    } finally {
      await control.close();
    }
    expect(await requestDaemonShutdown(configPath)).toBeNull();
  });

  it("refuses to signal a live PID that is not authenticated by the daemon control channel", async () => {
    const { configPath } = fixture();
    writeDaemonPid(configPath, process.pid);
    try {
      await expect(stopDaemon(configPath)).rejects.toThrow(/Refusing to signal pid/);
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally {
      removeDaemonPid(configPath, process.pid);
    }
  });

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
      backend: "pty",
      backend_ref: "proc_admin",
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
      const terminalSession = snapshot.terminal.sessions.find((session) => (session as Record<string, unknown>).process_id === "proc_admin");
      expect(terminalSession).toMatchObject({ process_id: "proc_admin", state: "running", live: false });
      expect(terminalSession).not.toHaveProperty("attach_command");
      expect(terminalSession).not.toHaveProperty("attach_read_only_command");
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

  it("limits active-request matching to the same recent window returned by the snapshot", () => {
    const { configPath, dataDir } = fixture();
    const db = openDatabase(join(dataDir, "state.db"));
    const audit = new AuditRepo(db);
    audit.append({ request_id: "req_recent_active", event_type: "request.accepted", metadata: { tool: "file_read" } });
    audit.append({ request_id: "req_recent_done", event_type: "request.accepted", metadata: { tool: "file_list" } });
    audit.append({ request_id: "req_recent_done", event_type: "response.returned", metadata: { tool: "file_list" } });
    db.prepare(
      "INSERT INTO audit_events(event_id,request_id,idempotency_key,process_id,event_type,metadata_json,timestamp) VALUES(?,?,?,?,?,?,?)",
    ).run(
      "evt_old_active",
      "req_old_active",
      null,
      null,
      "request.accepted",
      JSON.stringify({ tool: "file_search" }),
      new Date(Date.now() - 10 * 60_000).toISOString(),
    );
    db.close();

    const snapshot = buildAdminSnapshot(configPath, { recent: 20 });
    expect(snapshot.active_requests).toContainEqual(expect.objectContaining({ request_id: "req_recent_active" }));
    expect(snapshot.active_requests).not.toContainEqual(expect.objectContaining({ request_id: "req_recent_done" }));
    expect(snapshot.active_requests).not.toContainEqual(expect.objectContaining({ request_id: "req_old_active" }));
  });

  it("keeps active PTY sessions visible outside the recent-process limit", () => {
    const { configPath, dataDir } = fixture();
    const db = openDatabase(join(dataDir, "state.db"));
    const processes = new ProcessesRepo(db);
    processes.create({
      process_id: "proc_active_terminal",
      idempotency_key: "0199e78d-4c00-7000-8000-000000000911",
      target_id: "local",
      argv_digest: "sha256:terminal",
      cwd_relative: ".",
      backend: "pty",
      backend_ref: "proc_active_terminal",
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      max_output_bytes: 1024 * 1024,
    });
    processes.markRunning("proc_active_terminal", 12345, null);
    processes.create({
      process_id: "proc_newer_completed",
      idempotency_key: "0199e78d-4c00-7000-8000-000000000912",
      target_id: "local",
      argv_digest: "sha256:newer",
      cwd_relative: ".",
    });
    processes.markRunning("proc_newer_completed", 12346, 12346);
    processes.markTerminal("proc_newer_completed", "succeeded", 0, null, null);
    db.prepare("UPDATE processes SET started_at='2026-09-18T00:00:00.000Z' WHERE process_id='proc_active_terminal'").run();
    db.prepare("UPDATE processes SET started_at='2026-09-18T00:01:00.000Z', ended_at='2026-09-18T00:01:01.000Z' WHERE process_id='proc_newer_completed'").run();
    db.close();

    const spoolDir = join(dataDir, "spools", "processes", "proc_active_terminal");
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(join(spoolDir, "stdout.bin"), "prompt\n");

    const snapshot = buildAdminSnapshot(configPath, { recent: 1 });
    expect(snapshot.recent_processes).toEqual([expect.objectContaining({ process_id: "proc_newer_completed" })]);
    expect(snapshot.terminal.sessions).toContainEqual(
      expect.objectContaining({
        process_id: "proc_active_terminal",
        state: "running",
        live: false,
        output_bytes: 7,
        last_output_at: expect.any(String),
      }),
    );
  });

  it("rejects an unsupported state database instead of silently adapting it", () => {
    const { configPath, dataDir } = fixture();
    const path = join(dataDir, "state.db");
    mkdirSync(dataDir, { recursive: true });
    rmSync(path, { force: true });
    const unsupported = new Database(path);
    unsupported.exec(`
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
      VALUES('proc_unsupported','0199e78d-4c00-7000-8000-000000000902','local','sha256:test','.','running','2026-09-18T00:00:00.000Z');
    `);
    unsupported.close();

    expect(() => buildAdminSnapshot(configPath, { recent: 20 })).toThrow(/unsupported HostSpan database schema 3/);

    const check = new Database(path, { readonly: true });
    try {
      const columns = check.prepare("PRAGMA table_info(processes)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "backend")).toBe(false);
      expect((check.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe("3");
    } finally {
      check.close();
    }
  });

  it("rejects a current-version database whose required schema shape is incomplete", () => {
    const { configPath, dataDir } = fixture();
    const path = join(dataDir, "state.db");
    const created = openDatabase(path);
    created.close();

    const damaged = new Database(path);
    damaged.exec("ALTER TABLE processes DROP COLUMN backend_ref");
    damaged.close();

    expect(() => buildAdminSnapshot(configPath, { recent: 20 })).toThrow(
      new RegExp(`schema ${DB_SCHEMA_VERSION} is incomplete; processes is missing columns: backend_ref`),
    );
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
      exec_profile: "native-trusted",
    });
    expect(afterAdd.targets.local?.exec_profile).toBe("native");
    expect(afterAdd.exec_profiles.native?.policy).toBeUndefined();
    expect(afterAdd.exec_profiles.native?.allowed_programs).toEqual(["node"]);
    expect(afterAdd.exec_profiles["native-trusted"]).toMatchObject({
      policy: "trusted",
      allowed_programs: [],
      env_allowlist: [],
      max_deadline_ms: 60_000,
    });

    const removed = removeLocalWorkspace(configPath, "another-workspace");
    expect(removed).toMatchObject({ ok: true, target_id: "another-workspace", restart_required: true });
    expect(loadConfig(configPath).targets["another-workspace"]).toBeUndefined();
  });

  it("preserves an explicitly selected restricted exec profile", () => {
    const { root, configPath } = fixture();
    const workspace = join(root, "restricted-workspace");
    mkdirSync(workspace, { recursive: true });

    addLocalWorkspace(configPath, {
      target_id: "restricted-workspace",
      root: workspace,
      capabilities: ["read", "exec"],
      exec_profile: "native",
    });
    const config = loadConfig(configPath);
    expect(config.targets["restricted-workspace"]?.exec_profile).toBe("native");
    expect(config.exec_profiles.native?.policy).toBeUndefined();
    expect(config.exec_profiles["native-trusted"]).toBeUndefined();
  });

  it("derives target id and label from the folder and avoids id collisions", () => {
    const { root, configPath } = fixture();
    const first = join(root, "My Project");
    const secondParent = join(root, "nested");
    const second = join(secondParent, "My Project");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });

    const addedFirst = addLocalWorkspace(configPath, {
      root: first,
      capabilities: ["read", "write", "exec", "git", "terminal"],
    });
    expect(addedFirst).toMatchObject({ target_id: "my-project" });
    expect(loadConfig(configPath).targets["my-project"]).toMatchObject({
      label: "My Project",
      capabilities: ["read", "write", "exec", "git", "terminal"],
    });

    const addedSecond = addLocalWorkspace(configPath, {
      root: second,
      capabilities: ["read"],
    });
    expect(addedSecond).toMatchObject({ target_id: "my-project-2" });
    expect(loadConfig(configPath).targets["my-project-2"]?.label).toBe("My Project");
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
