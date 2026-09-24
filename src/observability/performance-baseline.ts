export interface PerformanceAuditEvent {
  request_id: string;
  event_type: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface WireSample {
  scenario: string;
  elapsed_ms: number;
  response_bytes: number;
}

export interface Distribution {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function distribution(values: number[]): Distribution {
  if (!values.length) return { count: 0, p50: null, p95: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? null;
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? null,
  };
}

function rate(count: number, total: number): number {
  return total > 0 ? Number((count / total).toFixed(4)) : 0;
}

function groupedDistribution<T>(
  items: T[],
  key: (item: T) => string,
  value: (item: T) => number,
): Record<string, Distribution> {
  const groups = new Map<string, number[]>();
  for (const item of items) {
    const name = key(item);
    const values = groups.get(name) ?? [];
    values.push(value(item));
    groups.set(name, values);
  }
  return Object.fromEntries(
    [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, values]) => [name, distribution(values)]),
  );
}

function timestampMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTerminalEvent(event: PerformanceAuditEvent): boolean {
  return event.event_type === "response.returned" || event.event_type === "request.aborted";
}

function summarizeTerminalEvents(events: PerformanceAuditEvent[]) {
  let calls = 0;
  let completed = 0;
  let aborted = 0;
  const latency: number[] = [];
  let retryable = 0;
  let retryableKnown = 0;
  let busy = 0;
  let outputLimited = 0;
  const errorsByCode: Record<string, number> = {};
  for (const event of events) {
    if (!isTerminalEvent(event)) continue;
    calls += 1;
    if (event.event_type === "response.returned") completed += 1;
    else aborted += 1;
    const duration = finiteNumber(event.metadata.total_ms);
    if (duration !== null) latency.push(duration);
    if (event.metadata.output_limited === true || event.metadata.error_code === "OUTPUT_LIMIT" || event.metadata.error_reason === "output_limit_exceeds_profile") {
      outputLimited += 1;
    }
    if (event.event_type !== "request.aborted") continue;
    const code = typeof event.metadata.error_code === "string" ? event.metadata.error_code : "<unknown>";
    errorsByCode[code] = (errorsByCode[code] ?? 0) + 1;
    if (typeof event.metadata.retryable === "boolean") {
      retryableKnown += 1;
      if (event.metadata.retryable) retryable += 1;
    }
    if (code === "SERVER_BUSY") busy += 1;
  }
  return {
    calls,
    completed,
    aborted,
    abort_rate: rate(aborted, calls),
    latency_ms: distribution(latency),
    busy: { count: busy, rate: rate(busy, calls) },
    retryable_errors: {
      count: retryable,
      known_aborts: retryableKnown,
      unknown_aborts: aborted - retryableKnown,
      rate: rate(retryable, calls),
    },
    output_limited: {
      count: outputLimited,
      rate: rate(outputLimited, calls),
      coverage_note: "historical audit exposes explicit output-limit markers only; terminal completions did not always persist an output-limit reason",
    },
    errors_by_code: Object.fromEntries(Object.entries(errorsByCode).sort(([left], [right]) => left.localeCompare(right))),
    response_bytes: {
      available: false,
      reason: "historical audit does not record serialized response bytes; use the isolated wire baseline",
    },
  };
}

export const PERFORMANCE_BASELINE_DEFAULT_EVENTS = 10_000;
export const PERFORMANCE_BASELINE_MAX_EVENTS = 50_000;

export function summarizeAuditPerformance(events: PerformanceAuditEvent[], maxGapMs = 300_000) {
  const chronological = [...events].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const accepted = chronological.filter((event) => event.event_type === "request.accepted");
  const terminal = chronological.filter(isTerminalEvent);
  const acceptedTimes = accepted.map((event) => timestampMs(event.timestamp)).filter((value): value is number => value !== null);
  const gaps: number[] = [];
  let nextAcceptedIndex = 0;
  for (const event of terminal) {
    const completedAt = timestampMs(event.timestamp);
    if (completedAt === null) continue;
    while ((acceptedTimes[nextAcceptedIndex] ?? Number.POSITIVE_INFINITY) <= completedAt) nextAcceptedIndex += 1;
    const nextAccepted = acceptedTimes[nextAcceptedIndex];
    if (nextAccepted === undefined) continue;
    const gap = nextAccepted - completedAt;
    if (gap >= 0 && gap <= maxGapMs) gaps.push(gap);
  }

  const byTool = new Map<string, PerformanceAuditEvent[]>();
  for (const event of terminal) {
    const tool = typeof event.metadata.tool === "string" ? event.metadata.tool : "<unknown>";
    const group = byTool.get(tool) ?? [];
    group.push(event);
    byTool.set(tool, group);
  }

  return {
    sample: {
      event_count: chronological.length,
      accepted_count: accepted.length,
      terminal_call_count: terminal.length,
      from: chronological[0]?.timestamp ?? null,
      to: chronological.at(-1)?.timestamp ?? null,
    },
    overall: summarizeTerminalEvents(terminal),
    tools: Object.fromEntries(
      [...byTool.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([tool, toolEvents]) => [tool, summarizeTerminalEvents(toolEvents)]),
    ),
    result_to_next_call_gap_ms: {
      ...distribution(gaps),
      max_gap_ms: maxGapMs,
      caveat: "global chronological gap; concurrent clients are not session-correlated",
    },
  };
}

export function buildPerformanceBaseline(
  audit: { recentPerformanceEvents(limit: number): Array<Record<string, unknown>> },
  recent = PERFORMANCE_BASELINE_DEFAULT_EVENTS,
  maxGapMs = 300_000,
) {
  const requested = Number.isFinite(recent) ? Math.floor(recent) : PERFORMANCE_BASELINE_DEFAULT_EVENTS;
  const limit = Math.max(1, Math.min(requested, PERFORMANCE_BASELINE_MAX_EVENTS));
  const events = audit.recentPerformanceEvents(limit) as unknown as PerformanceAuditEvent[];
  return {
    event_limit: limit,
    ...summarizeAuditPerformance(events, maxGapMs),
  };
}

export function summarizeWireSamples(samples: WireSample[]) {
  return {
    sample_count: samples.length,
    latency_ms: {
      overall: distribution(samples.map((sample) => sample.elapsed_ms)),
      by_scenario: groupedDistribution(samples, (sample) => sample.scenario, (sample) => sample.elapsed_ms),
    },
    response_bytes: {
      overall: distribution(samples.map((sample) => sample.response_bytes)),
      by_scenario: groupedDistribution(samples, (sample) => sample.scenario, (sample) => sample.response_bytes),
    },
  };
}
