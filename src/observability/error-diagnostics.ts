import type { HostSpanError } from "../mcp/errors.js";

const SAFE_ERROR_REASONS = new Set([
  "admin_config_mutation_denied",
  "capacity_saturated",
  "daemon_identity_unconfirmed",
  "daemon_running",
  "deadline_exceeded",
  "deadline_exceeds_profile",
  "environment_not_allowed",
  "exec_profile_mode_unsupported",
  "exec_profile_not_configured",
  "file_read_scan_limit",
  "git_content_filter_unsafe",
  "interactive_write_outcome_unknown",
  "interactive_write_restart_boundary",
  "invalid_glob",
  "invalid_regex",
  "max_concurrent_processes",
  "max_concurrent_terminal_sessions",
  "missing_argument",
  "missing_program",
  "multiple_git_repositories",
  "output_limit",
  "output_limit_exceeds_profile",
  "path_denied_by_policy",
  "program_not_allowed",
  "target_missing_exec_profile",
  "unknown_command",
]);

const SAFE_ERROR_RESOURCES = new Set(["file_search", "git_attributes", "git_changes", "git_status", "process_output_spool"]);

export function auditErrorDiagnostics(error: HostSpanError): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    error_code: error.code,
    retryable: error.retryable,
  };
  const reason = error.details.reason;
  if (typeof reason === "string" && SAFE_ERROR_REASONS.has(reason)) metadata.error_reason = reason;
  const resource = error.details.resource;
  if (typeof resource === "string" && SAFE_ERROR_RESOURCES.has(resource)) metadata.error_resource = resource;
  return metadata;
}
