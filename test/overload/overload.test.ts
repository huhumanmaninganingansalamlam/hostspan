import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { BoundedConcurrencyLimiter } from "../../src/runtime/concurrency-limiter.js";
import type { HostSpanToolHandlers } from "../../src/mcp/registry.js";
import { createHostSpanHttpServer } from "../../src/mcp/server.js";
import { AuditRepo } from "../../src/state/audit-repo.js";
import { DB_SCHEMA_VERSION, databaseHealthy, openDatabase } from "../../src/state/database.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";

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
    const limiter = new BoundedConcurrencyLimiter({
      maxConcurrent: 2,
      maxQueued: 2,
      queueTimeoutMs: 5_000,
      resource: "file_search",
      label: "Search",
    });
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
      details: { resource: "file_search", reason: "capacity_saturated", max_concurrent: 2, max_queued: 2 },
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
    const limiter = new BoundedConcurrencyLimiter({
      maxConcurrent: 1,
      maxQueued: 1,
      queueTimeoutMs: 20,
      resource: "file_search",
      label: "Search",
    });
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

  it("returns only active PTY processes for the requested target", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-process-indexes-"));
    roots.push(root);
    const db = openDatabase(join(root, "state.db"));
    try {
      const processes = new ProcessesRepo(db);
      processes.create({
        process_id: "proc_native_active",
        idempotency_key: "0199e78d-4c00-7000-8000-000000000921",
        target_id: "local",
        argv_digest: "sha256:native",
        cwd_relative: ".",
      });
      processes.markRunning("proc_native_active", 100, 100);
      processes.create({
        process_id: "proc_pty_active",
        idempotency_key: "0199e78d-4c00-7000-8000-000000000922",
        target_id: "local",
        argv_digest: "sha256:pty",
        cwd_relative: ".",
        backend: "pty",
      });
      processes.markRunning("proc_pty_active", 101, null);
      expect(processes.activeInteractive().map((record) => record.process_id)).toEqual(["proc_pty_active"]);
      expect(processes.activeInteractive("local").map((record) => record.process_id)).toEqual(["proc_pty_active"]);
      expect(processes.activeInteractive("other")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("reopens the current WAL database without creating a side-copy backup", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-current-db-"));
    roots.push(root);
    const path = join(root, "state.db");
    const first = openDatabase(path);
    first
      .prepare("INSERT INTO audit_events(event_id,request_id,event_type,metadata_json,timestamp) VALUES(?,?,?,?,?)")
      .run("evt_current", "req_current", "test", "{}", new Date().toISOString());
    first.exec("DROP INDEX processes_active_backend_target_idx; DROP INDEX processes_activity_idx;");
    first.close();

    const reopened = openDatabase(path);
    try {
      expect((reopened.prepare("SELECT count(*) AS count FROM audit_events WHERE event_id='evt_current'").get() as { count: number }).count).toBe(1);
      const indexes = new Set(
        (reopened.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'processes_%_idx'").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );
      expect(indexes).toEqual(new Set(["processes_active_backend_target_idx", "processes_activity_idx"]));
      expect(existsSync(`${path}.bak`)).toBe(false);
    } finally {
      reopened.close();
    }
  });

  it("recovers an empty database file left by an interrupted first initialization", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-empty-db-"));
    roots.push(root);
    const path = join(root, "state.db");
    writeFileSync(path, "");

    const db = openDatabase(path);
    try {
      expect(databaseHealthy(db)).toBe(true);
      expect((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe(String(DB_SCHEMA_VERSION));
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
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

  it.each([1, 2, 3, 4])("rejects unsupported schema %s without modifying it", (schemaVersion) => {
    const root = mkdtempSync(join(tmpdir(), `hostspan-unsupported-schema-${schemaVersion}-`));
    roots.push(root);
    const path = join(root, "state.db");
    const unsupported = new Database(path);
    unsupported.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    unsupported.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(schemaVersion));
    unsupported.close();
    const before = readFileSync(path);

    expect(() => openDatabase(path)).toThrow(new RegExp(`unsupported HostSpan database schema ${schemaVersion}`));
    const check = new Database(path, { readonly: true });
    try {
      expect((check.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe(String(schemaVersion));
      expect(check.pragma("journal_mode", { simple: true })).toBe("delete");
    } finally {
      check.close();
    }
    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(`${path}-wal`)).toBe(false);
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
