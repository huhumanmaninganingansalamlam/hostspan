import { v7 as uuidv7 } from "uuid";
import type { HostSpanDatabase } from "./database.js";

export interface AuditRepoOptions {
  maxAgeDays: number;
  maxEvents: number;
}

export class AuditRepo {
  private appendsSinceMaintenance = 0;
  private nextMaintenanceAt = 0;

  constructor(
    private readonly db: HostSpanDatabase,
    private readonly options?: AuditRepoOptions,
  ) {}

  append(event: {
    request_id: string;
    event_type: string;
    metadata?: Record<string, unknown>;
    idempotency_key?: string;
    process_id?: string;
  }): void {
    this.db
      .prepare("INSERT INTO audit_events(event_id,request_id,idempotency_key,process_id,event_type,metadata_json,timestamp) VALUES(?,?,?,?,?,?,?)")
      .run(
        `evt_${uuidv7().replaceAll("-", "")}`,
        event.request_id,
        event.idempotency_key ?? null,
        event.process_id ?? null,
        event.event_type,
        JSON.stringify(event.metadata ?? {}),
        new Date().toISOString(),
      );
    this.appendsSinceMaintenance += 1;
    if (this.options && (this.appendsSinceMaintenance >= 10_000 || Date.now() >= this.nextMaintenanceAt)) {
      this.maintain();
    }
  }

  maintain(nowMs = Date.now()): { deleted_by_age: number; deleted_by_cap: number; retained: number } {
    if (!this.options) {
      const retained = (this.db.prepare("SELECT count(*) AS count FROM audit_events").get() as { count: number }).count;
      return { deleted_by_age: 0, deleted_by_cap: 0, retained };
    }
    const options = this.options;
    const cutoff = new Date(nowMs - options.maxAgeDays * 86_400_000).toISOString();
    const result = this.db.transaction(() => {
      const deletedByAge = this.db.prepare("DELETE FROM audit_events WHERE timestamp < ?").run(cutoff).changes;
      const count = (this.db.prepare("SELECT count(*) AS count FROM audit_events").get() as { count: number }).count;
      const overflow = Math.max(0, count - options.maxEvents);
      let deletedByCap = 0;
      if (overflow > 0) {
        deletedByCap = this.db
          .prepare(
            `DELETE FROM audit_events
             WHERE rowid IN (
               SELECT rowid FROM audit_events
               ORDER BY timestamp ASC, event_id ASC
               LIMIT ?
             )`,
          )
          .run(overflow).changes;
      }
      return {
        deleted_by_age: deletedByAge,
        deleted_by_cap: deletedByCap,
        retained: count - deletedByCap,
      };
    })();
    this.appendsSinceMaintenance = 0;
    this.nextMaintenanceAt = nowMs + 60_000;
    return result;
  }

  recent(limit = 500): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare("SELECT event_id,request_id,idempotency_key,process_id,event_type,metadata_json,timestamp FROM audit_events ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown> & { metadata_json: string }>;
    return rows.map(({ metadata_json, ...row }) => ({ ...row, metadata: JSON.parse(metadata_json) }));
  }

  recentPerformanceEvents(limit = 10_000): Array<Record<string, unknown>> {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 50_000));
    const rows = this.db
      .prepare(
        `SELECT event_id,request_id,idempotency_key,process_id,event_type,metadata_json,timestamp
         FROM audit_events
         WHERE event_type IN ('request.accepted','response.returned','request.aborted')
         ORDER BY timestamp DESC,event_id DESC LIMIT ?`,
      )
      .all(bounded) as Array<Record<string, unknown> & { metadata_json: string }>;
    return rows.map(({ metadata_json, ...row }) => ({ ...row, metadata: JSON.parse(metadata_json) }));
  }

  activeRequests(since: string, limit = 100): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        `SELECT a.request_id,a.metadata_json,a.timestamp
         FROM audit_events a
         WHERE a.event_type='request.accepted'
           AND a.timestamp >= ?
           AND a.request_id NOT IN (
             SELECT done.request_id FROM audit_events done
             WHERE done.event_type IN ('response.returned','request.aborted')
               AND done.timestamp >= ?
           )
         ORDER BY a.timestamp DESC
         LIMIT ?`,
      )
      .all(since, since, limit) as Array<{ request_id: string; metadata_json: string; timestamp: string }>;
    return rows.map((row) => ({ request_id: row.request_id, timestamp: row.timestamp, metadata: JSON.parse(row.metadata_json) }));
  }
}
