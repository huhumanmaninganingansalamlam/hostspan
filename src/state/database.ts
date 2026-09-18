import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { HostSpanConfig } from "../config/schema.js";
import type { TargetRegistry } from "../targets/registry.js";

export const DB_SCHEMA_VERSION = 3;

export type HostSpanDatabase = Database.Database;

export function openDatabase(path: string): HostSpanDatabase {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existed = existsSync(path);
  if (existed) copyFileSync(path, `${path}.pre-migration.bak`);
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const current = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  if (current && Number(current.value) > DB_SCHEMA_VERSION) {
    db.close();
    throw new Error(`database schema ${current.value} is newer than supported ${DB_SCHEMA_VERSION}`);
  }
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS targets_snapshot (
        target_id TEXT PRIMARY KEY, config_digest TEXT NOT NULL, policy_epoch INTEGER NOT NULL,
        provider TEXT NOT NULL, root_fingerprint TEXT NOT NULL, ready INTEGER NOT NULL, last_checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        idempotency_key TEXT PRIMARY KEY, tool_name TEXT NOT NULL, argument_hash TEXT NOT NULL,
        target_id TEXT, state TEXT NOT NULL, result_json TEXT, error_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processes (
        process_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, target_id TEXT NOT NULL,
        argv_digest TEXT NOT NULL, cwd_relative TEXT NOT NULL, pid INTEGER, pgid INTEGER,
        state TEXT NOT NULL, exit_code INTEGER, term_signal TEXT, reason TEXT,
        started_at TEXT, ended_at TEXT, stdout_bytes INTEGER NOT NULL DEFAULT 0,
        stderr_bytes INTEGER NOT NULL DEFAULT 0, output_expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS patch_transactions (
        transaction_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, target_id TEXT NOT NULL,
        journal_path TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, idempotency_key TEXT, process_id TEXT,
        event_type TEXT NOT NULL, metadata_json TEXT NOT NULL, timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_events_timestamp_idx ON audit_events(timestamp, event_id);
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
        request_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL, state TEXT, code_challenge TEXT NOT NULL, resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL, code_challenge TEXT NOT NULL, resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL, used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS oauth_access_tokens (
        token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL,
        resource TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL,
        resource TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
      );
    `);
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(String(DB_SCHEMA_VERSION));
  })();
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
