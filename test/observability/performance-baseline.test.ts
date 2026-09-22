import { describe, expect, it } from "vitest";
import {
  buildPerformanceBaseline,
  summarizeAuditPerformance,
  summarizeWireSamples,
  type PerformanceAuditEvent,
} from "../../src/observability/performance-baseline.js";
import { AuditRepo } from "../../src/state/audit-repo.js";
import { openMemoryDatabase } from "../../src/state/database.js";

function event(
  request_id: string,
  event_type: string,
  timestamp: string,
  metadata: Record<string, unknown>,
): PerformanceAuditEvent {
  return { request_id, event_type, timestamp, metadata };
}

describe("performance baseline", () => {
  it("summarizes bounded audit latency, errors, and global next-call gaps", () => {
    const events = [
      event("req1", "request.accepted", "2026-09-22T00:00:00.000Z", { tool: "file_read" }),
      event("req1", "response.returned", "2026-09-22T00:00:00.010Z", { tool: "file_read", total_ms: 10 }),
      event("req2", "request.accepted", "2026-09-22T00:00:00.020Z", { tool: "file_search" }),
      event("req2", "request.aborted", "2026-09-22T00:00:00.030Z", {
        tool: "file_search",
        total_ms: 10,
        error_code: "SERVER_BUSY",
        retryable: true,
      }),
      event("req3", "request.accepted", "2026-09-22T00:00:00.040Z", { tool: "file_read" }),
      event("req3", "request.aborted", "2026-09-22T00:00:00.050Z", {
        tool: "file_read",
        total_ms: 30,
        error_code: "OUTPUT_LIMIT",
        retryable: false,
      }),
      event("req4", "request.accepted", "2026-09-22T00:00:00.060Z", { tool: "file_read" }),
      event("req4", "request.aborted", "2026-09-22T00:00:00.070Z", {
        tool: "file_read",
        total_ms: 70,
        error_code: "INTERNAL_ERROR",
      }),
    ];

    const report = summarizeAuditPerformance(events);
    expect(report.sample).toMatchObject({ event_count: 8, accepted_count: 4, terminal_call_count: 4 });
    expect(report.overall.latency_ms).toEqual({ count: 4, p50: 10, p95: 70, max: 70 });
    expect(report.tools.file_read?.latency_ms).toEqual({ count: 3, p50: 30, p95: 70, max: 70 });
    expect(report.overall.busy).toEqual({ count: 1, rate: 0.25 });
    expect(report.overall.retryable_errors).toEqual({
      count: 1,
      known_aborts: 2,
      unknown_aborts: 1,
      rate: 0.25,
    });
    expect(report.overall.output_limited).toMatchObject({ count: 1, rate: 0.25 });
    expect(report.overall.errors_by_code).toEqual({ INTERNAL_ERROR: 1, OUTPUT_LIMIT: 1, SERVER_BUSY: 1 });
    expect(report.overall.response_bytes.available).toBe(false);
    expect(report.result_to_next_call_gap_ms).toMatchObject({
      count: 3,
      p50: 10,
      p95: 10,
      max: 10,
      max_gap_ms: 300_000,
    });
  });

  it("bounds durable audit retrieval for the reusable baseline", () => {
    const db = openMemoryDatabase();
    try {
      const audit = new AuditRepo(db);
      audit.append({ request_id: "accepted", event_type: "request.accepted", metadata: { tool: "target_list" } });
      audit.append({ request_id: "accepted", event_type: "response.returned", metadata: { tool: "target_list", total_ms: 2 } });
      const report = buildPerformanceBaseline(audit, 50_001);
      expect(report.event_limit).toBe(50_000);
      expect(report.sample).toMatchObject({ event_count: 2, accepted_count: 1, terminal_call_count: 1 });
      expect(report.overall.latency_ms).toEqual({ count: 1, p50: 2, p95: 2, max: 2 });
    } finally {
      db.close();
    }
  });

  it("summarizes exact serialized response bytes by stable wire scenario", () => {
    const report = summarizeWireSamples([
      { scenario: "file_read_range", elapsed_ms: 3, response_bytes: 1000 },
      { scenario: "file_read_range", elapsed_ms: 5, response_bytes: 1200 },
      { scenario: "file_search", elapsed_ms: 9, response_bytes: 400 },
    ]);
    expect(report.latency_ms.overall).toEqual({ count: 3, p50: 5, p95: 9, max: 9 });
    expect(report.response_bytes.by_scenario.file_read_range).toEqual({ count: 2, p50: 1000, p95: 1200, max: 1200 });
    expect(report.response_bytes.by_scenario.file_search).toEqual({ count: 1, p50: 400, p95: 400, max: 400 });
  });

  it("keeps empty samples explicit", () => {
    const audit = summarizeAuditPerformance([]);
    const wire = summarizeWireSamples([]);
    expect(audit.overall.latency_ms).toEqual({ count: 0, p50: null, p95: null, max: null });
    expect(audit.result_to_next_call_gap_ms).toMatchObject({ count: 0, p50: null, p95: null, max: null });
    expect(wire.response_bytes.overall).toEqual({ count: 0, p50: null, p95: null, max: null });
  });
});
