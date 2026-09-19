import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SearchConcurrencyLimiter } from "../../src/files/search.js";
import type { HostSpanToolHandlers } from "../../src/mcp/registry.js";
import { createHostSpanHttpServer } from "../../src/mcp/server.js";
import { AuditRepo } from "../../src/state/audit-repo.js";
import { databaseHealthy, databaseResponsive, openDatabase } from "../../src/state/database.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("overload stability", () => {
  it("bounds concurrent searches and rejects overflow with a retryable busy error", async () => {
    const limiter = new SearchConcurrencyLimiter(2, 2, 5_000);
    const holds = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];

    const runs = holds.map((hold, index) =>
      limiter.run(async () => {
        started.push(index);
        await hold.promise;
        return index;
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1]);
    expect(limiter.snapshot()).toMatchObject({ active: 2, queued: 2, max_concurrent: 2, max_queued: 2 });

    await expect(limiter.run(async () => 99)).rejects.toMatchObject({
      code: "SERVER_BUSY",
      retryable: true,
      details: { resource: "file_search", max_concurrent: 2, max_queued: 2 },
    });

    holds[0]?.resolve();
    await expect(runs[0]).resolves.toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toContain(2);
    expect(limiter.snapshot()).toMatchObject({ active: 2, queued: 1 });

    for (const hold of holds.slice(1)) hold.resolve();
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3]);
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("times out queued searches instead of letting the queue grow stale", async () => {
    const limiter = new SearchConcurrencyLimiter(1, 1, 20);
    const hold = deferred();
    const active = limiter.run(async () => {
      await hold.promise;
      return "done";
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(limiter.run(async () => "queued")).rejects.toMatchObject({
      code: "SERVER_BUSY",
      retryable: true,
    });
    expect(limiter.snapshot()).toMatchObject({ active: 1, queued: 0 });
    hold.resolve();
    await expect(active).resolves.toBe("done");
  });

  it("uses a lightweight database responsiveness probe while retaining integrity checks", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-overload-db-"));
    roots.push(root);
    const db = openDatabase(join(root, "state.db"));
    try {
      expect(databaseResponsive(db)).toBe(true);
      expect(databaseHealthy(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("bounds durable audit history by age and event count", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-overload-audit-"));
    roots.push(root);
    const db = openDatabase(join(root, "state.db"));
    try {
      const audit = new AuditRepo(db, { maxAgeDays: 30, maxEvents: 3 });
      for (let index = 0; index < 5; index += 1) {
        audit.append({ request_id: `req_${index}`, event_type: "load.test", metadata: { index } });
      }
      const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
      db.prepare(
        "UPDATE audit_events SET timestamp=? WHERE rowid=(SELECT rowid FROM audit_events ORDER BY timestamp ASC, event_id ASC LIMIT 1)",
      ).run(old);
      const result = audit.maintain();
      expect(result).toEqual({ deleted_by_age: 1, deleted_by_cap: 1, retained: 3 });
      expect(audit.recent(10)).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it("migrates schema 2 audit state to schema 4 without losing events", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-overload-migration-"));
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key,value) VALUES('schema_version','2');
      CREATE TABLE audit_events (
        event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, idempotency_key TEXT, process_id TEXT,
        event_type TEXT NOT NULL, metadata_json TEXT NOT NULL, timestamp TEXT NOT NULL
      );
      INSERT INTO audit_events(event_id,request_id,event_type,metadata_json,timestamp)
      VALUES('evt_existing','req_existing','test','{}','2026-09-18T00:00:00.000Z');
    `);
    legacy.close();

    const db = openDatabase(path);
    try {
      const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string };
      const events = (db.prepare("SELECT count(*) AS count FROM audit_events").get() as { count: number }).count;
      const index = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='audit_events_timestamp_idx'")
        .get() as { name: string } | undefined;
      expect(version.value).toBe("4");
      expect(events).toBe(1);
      expect(index?.name).toBe("audit_events_timestamp_idx");
      expect(existsSync(`${path}.pre-migration.bak`)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("migrates a schema 3 process row to the interactive-backend schema 4 shape", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-process-migration-"));
    roots.push(root);
    const path = join(root, "state.db");
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
      INSERT INTO processes(process_id,idempotency_key,target_id,argv_digest,cwd_relative,state,pid,pgid)
      VALUES('proc_existing','0199e78d-4c00-7000-8000-000000000950','local','sha256:test','.','running',123,123);
    `);
    legacy.close();

    const db = openDatabase(path);
    try {
      const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string };
      const row = db.prepare("SELECT process_id,state,backend,backend_ref,deadline_at,max_output_bytes FROM processes WHERE process_id='proc_existing'").get() as {
        process_id: string;
        state: string;
        backend: string;
        backend_ref: string | null;
        deadline_at: string | null;
        max_output_bytes: number | null;
      };
      expect(version.value).toBe("4");
      expect(row).toEqual({
        process_id: "proc_existing",
        state: "running",
        backend: "native",
        backend_ref: null,
        deadline_at: null,
        max_output_bytes: null,
      });
      expect(existsSync(`${path}.pre-migration.bak`)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("fails fast when MCP in-flight capacity is saturated and recovers after release", async () => {
    const hold = deferred();
    const handlers: HostSpanToolHandlers = {
      system_status: async () => {
        await hold.promise;
        return { ok: true };
      },
      target_list: () => ({ targets: [] }),
      file_list: () => ({ entries: [] }),
      file_read: () => ({ text: "" }),
      file_search: () => ({ matches: [] }),
      file_patch: () => ({ state: "succeeded" }),
      git_changes: () => ({ status: [] }),
      process_start: () => ({ state: "succeeded" }),
      process_poll: () => ({ state: "succeeded" }),
      process_write: () => ({ state: "succeeded" }),
      process_cancel: () => ({ state: "cancelled" }),
    };
    const app = createHostSpanHttpServer({
      listen_host: "127.0.0.1",
      listen_port: 0,
      max_inflight_mcp_requests: 1,
      handlers,
      responseContext: () => ({ toolset_hash: "sha256:test", policy_epoch: 1 }),
      status: { health: () => ({}), readiness: () => ({ ready: true }) },
    });
    const payload = {
      jsonrpc: "2.0",
      id: "busy-test",
      method: "tools/call",
      params: {
        name: "system_status",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "overload-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };
    const request = () =>
      app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "system_status",
          "mcp-protocol-version": "2026-07-28",
        },
        payload,
      });

    try {
      const first = request();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const overloaded = await request();
      expect(overloaded.statusCode).toBe(503);
      expect(overloaded.headers["retry-after"]).toBe("1");
      expect(overloaded.json()).toMatchObject({
        jsonrpc: "2.0",
        error: { message: "HostSpan is busy; retry shortly." },
        id: null,
      });

      hold.resolve();
      await expect(first).resolves.toMatchObject({ statusCode: 200 });
      const recovered = await request();
      expect(recovered.statusCode).toBe(200);
    } finally {
      hold.resolve();
      await app.close();
    }
  });
});
