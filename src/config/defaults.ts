import { ExecProfileSchema, HostSpanConfigSchema, type HostSpanConfig } from "./schema.js";
import { defaultDataDir } from "./paths.js";

export function createNativeExecProfile(): HostSpanConfig["exec_profiles"][string] {
  return ExecProfileSchema.parse({ mode: "native" });
}

export function createInitialConfig(): HostSpanConfig {
  return HostSpanConfigSchema.parse({
    schema_version: 1,
    policy_epoch: 1,
    server: {
      allowed_hosts: [],
      data_dir: defaultDataDir(),
      max_inflight_mcp_requests: 128,
      max_concurrent_searches: 8,
      max_queued_searches: 16,
      search_queue_timeout_ms: 1_000,
    },
    retention: {
      max_audit_events: 500_000,
    },
    terminal: {},
    targets: {},
    exec_profiles: {
      "native-dev": createNativeExecProfile(),
    },
  });
}
