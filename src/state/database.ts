import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { HostSpanConfig } from "../config/schema.js";
import type { TargetRegistry } from "../targets/registry.js";

export const DB_SCHEMA_VERSION = 5;

export type HostSpanDatabase = Database.Database;

const CURRENT_TABLES = [
  "meta",
  "targets_snapshot",
  "operations",
  "processes",
  "patch_transactions",
  "audit_events",
  "oauth_clients",
  "oauth_authorization_requests",
  "oauth_authorization_codes",
  "oauth_access_tokens",
  "oauth_refresh_tokens",
] as const;

const REQUIRED_COLUMNS: Record<(typeof CURRENT_TABLES)[number], readonly string[]> = {
  meta: ["key", "value"],
  targets_snapshot: ["target_id", "config_digest", "policy_epoch", "provider", "root_fingerprint", "ready", "last_checked_at"],
  operations: ["idempotency_key", "tool_name", "argument_hash", "target_id", "state", "result_json", "error_json", "created_at", "updated_at"],
  processes: [
    "process_id",
    "idempotency_key",
    "target_id",
    "argv_digest",
    "cwd_relative",
    "backend",
    "backend_ref",
    "pid",
    "pgid",
    "deadline_at",
    "max_output_bytes",
    "state",
    "exit_code",
    "term_signal",
    "reason",
    "started_at",
    "ended_at",
    "stdout_bytes",
    "stderr_bytes",
    "output_expires_at",
  ],
  patch_transactions: ["transaction_id", "idempotency_key", "target_id", "journal_path", "state", "created_at", "updated_at"],
  audit_events: ["event_id", "request_id", "idempotency_key", "process_id", "event_type", "metadata_json", "timestamp"],
  oauth_clients: ["client_id", "metadata_json", "created_at"],
  oauth_authorization_requests: ["request_id", "client_id", "redirect_uri", "scope", "state", "code_challenge", "resource", "expires_at"],
  oauth_authorization_codes: ["code_hash", "client_id", "redirect_uri", "scope", "code_challenge", "resource", "expires_at", "used_at"],
  oauth_access_tokens: ["token_hash", "client_id", "scope", "resource", "expires_at", "revoked_at"],
  oauth_refresh_tokens: ["token_hash", "client_id", "scope", "resource", "expires_at", "revoked_at"],
};

function currentSchemaVersion(db: HostSpanDatabase): number | null {
  const meta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get() as { name: string } | undefined;
  if (!meta) return null;
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
  if (!row) return null;
  const version = Number(row.value);
  return Number.isInteger(version) ? version : null;
}

function userTableNames(db: HostSpanDatabase): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function validateCurrentSchema(db: HostSpanDatabase): void {
  const version = currentSchemaVersion(db);
  if (version !== DB_SCHEMA_VERSION) {
    throw new Error(
      `unsupported HostSpan database schema ${version ?? "<missing>"}; expected ${DB_SCHEMA_VERSION}. ` +
        "HostSpan supports only the current state database format.",
    );
  }
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name),
  );
  const missing = CURRENT_TABLES.filter((table) => !tables.has(table));
  if (missing.length) throw new Error(`HostSpan database schema ${DB_SCHEMA_VERSION} is incomplete; missing: ${missing.join(", ")}`);
  for (const table of CURRENT_TABLES) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    const missingColumns = REQUIRED_COLUMNS[table].filter((column) => !columns.has(column));
    if (missingColumns.length) {
      throw new Error(
        `HostSpan database schema ${DB_SCHEMA_VERSION} is incomplete; ${table} is missing columns: ${missingColumns.join(", ")}`,
      );
    }
  }
  const invalidBackend = db
    .prepare("SELECT process_id,backend FROM processes WHERE backend NOT IN ('native','pty') LIMIT 1")
    .get() as { process_id: string; backend: string } | undefined;
  if (invalidBackend) {
    throw new Error(
      `HostSpan database schema ${DB_SCHEMA_VERSION} contains unsupported process backend ${invalidBackend.backend} for ${invalidBackend.process_id}.`,
    );
  }
}

function initializeCurrentSchema(db: HostSpanDatabase): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE targets_snapshot (
        target_id TEXT PRIMARY KEY, config_digest TEXT NOT NULL, policy_epoch INTEGER NOT NULL,
        provider TEXT NOT NULL, root_fingerprint TEXT NOT NULL, ready INTEGER NOT NULL, last_checked_at TEXT NOT NULL
      );
      CREATE TABLE operations (
        idempotency_key TEXT PRIMARY KEY, tool_name TEXT NOT NULL, argument_hash TEXT NOT NULL,
        target_id TEXT, state TEXT NOT NULL, result_json TEXT, error_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE processes (
        process_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, target_id TEXT NOT NULL,
        argv_digest TEXT NOT NULL, cwd_relative TEXT NOT NULL,
        backend TEXT NOT NULL DEFAULT 'native' CHECK (backend IN ('native','pty')), backend_ref TEXT,
        pid INTEGER, pgid INTEGER, deadline_at TEXT, max_output_bytes INTEGER,
        state TEXT NOT NULL, exit_code INTEGER, term_signal TEXT, reason TEXT,
        started_at TEXT, ended_at TEXT, stdout_bytes INTEGER NOT NULL DEFAULT 0,
        stderr_bytes INTEGER NOT NULL DEFAULT 0, output_expires_at TEXT
      );
      CREATE TABLE patch_transactions (
        transaction_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, target_id TEXT NOT NULL,
        journal_path TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE audit_events (
        event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, idempotency_key TEXT, process_id TEXT,
        event_type TEXT NOT NULL, metadata_json TEXT NOT NULL, timestamp TEXT NOT NULL
      );
      CREATE INDEX audit_events_timestamp_idx ON audit_events(timestamp, event_id);
      CREATE TABLE oauth_clients (
        client_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE oauth_authorization_requests (
        request_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL, state TEXT, code_challenge TEXT NOT NULL, resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE oauth_authorization_codes (
        code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL, code_challenge TEXT NOT NULL, resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL, used_at INTEGER
      );
      CREATE TABLE oauth_access_tokens (
        token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL,
        resource TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL,
        resource TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
      );
    `);
    db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)").run(String(DB_SCHEMA_VERSION));
  })();
}

export function openDatabase(path: string): HostSpanDatabase {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existed = existsSync(path);
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = ON");
    if (!existed || userTableNames(db).length === 0) initializeCurrentSchema(db);
    else validateCurrentSchema(db);
    db.pragma("journal_mode = WAL");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function openReadOnlyDatabase(path: string): HostSpanDatabase {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma("foreign_keys = ON");
    validateCurrentSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openMemoryDatabase(): HostSpanDatabase {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeCurrentSchema(db);
  return db;
}

export function databaseHealthy(db: HostSpanDatabase): boolean {
  const row = db.pragma("integrity_check", { simple: true });
  return row === "ok";
}

export function databaseResponsive(db: HostSpanDatabase): boolean {
  const row = db.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
  return row?.ok === 1;
}

export function syncTargetSnapshots(db: HostSpanDatabase, config: HostSpanConfig, targets: TargetRegistry): void {
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO targets_snapshot(
      target_id, config_digest, policy_epoch, provider, root_fingerprint, ready, last_checked_at
    ) VALUES(?,?,?,?,?,?,?)
  `);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("DELETE FROM targets_snapshot").run();
    for (const target of targets.list()) {
      const source = config.targets[target.target_id];
      const digest = `sha256:${createHash("sha256").update(JSON.stringify(source)).digest("hex")}`;
      upsert.run(
        target.target_id,
        digest,
        config.policy_epoch,
        target.provider,
        targets.fingerprint(target),
        target.ready ? 1 : 0,
        now,
      );
    }
  })();
}
