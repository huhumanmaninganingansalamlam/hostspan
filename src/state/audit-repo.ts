import { v7 as uuidv7 } from "uuid";
import type { HostSpanDatabase } from "./database.js";

export class AuditRepo {
  constructor(private readonly db: HostSpanDatabase) {}

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
  }

  recent(limit = 500): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare("SELECT event_id,request_id,idempotency_key,process_id,event_type,metadata_json,timestamp FROM audit_events ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown> & { metadata_json: string }>;
    return rows.map(({ metadata_json, ...row }) => ({ ...row, metadata: JSON.parse(metadata_json) }));
  }
}
