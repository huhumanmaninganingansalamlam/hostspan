import type { HostSpanConfig } from "./schema.js";
import { defaultDataDir } from "./paths.js";

export function createTrustedExecProfile(): HostSpanConfig["exec_profiles"][string] {
  return {
    mode: "native",
    policy: "trusted",
    allowed_programs: [],
    env_allowlist: [],
    default_deadline_ms: 30_000,
    max_deadline_ms: 600_000,
    default_output_bytes: 4_194_304,
    max_output_bytes: 67_108_864,
    max_concurrent_processes: 4,
  };
}

export function createInitialConfig(): HostSpanConfig {
  return {
    schema_version: 1,
    policy_epoch: 1,
    server: {
      listen_host: "127.0.0.1",
      listen_port: 39393,
      allowed_hosts: [],
      data_dir: defaultDataDir(),
      max_inflight_mcp_requests: 128,
      max_concurrent_searches: 8,
      max_queued_searches: 16,
      search_queue_timeout_ms: 1_000,
      max_concurrent_git_changes: 4,
      max_queued_git_changes: 8,
      git_queue_timeout_ms: 1_000,
    },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_audit_events: 500_000,
      max_total_spool_bytes: 1_073_741_824,
    },
    terminal: {
      backend: "pty",
      max_concurrent_sessions: 16,
      attach_history_bytes: 65_536,
      max_output_bytes: 16_777_216,
    },
    targets: {},
    exec_profiles: {
      "native-dev": createTrustedExecProfile(),
    },
  };
}
