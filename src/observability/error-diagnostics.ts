import type { HostSpanError } from "../errors.js";
import { HOSTSPAN_OAUTH_SCOPES } from "../auth/oauth-scopes.js";
import { argumentHash } from "../state/operations-repo.js";

const SAFE_ERROR_REASONS = new Set([
  "admin_config_mutation_denied",
  "capacity_saturated",
  "daemon_identity_unconfirmed",
  "daemon_running",
  "deadline_exceeded",
  "exec_profile_mode_unsupported",
  "exec_profile_not_configured",
  "file_read_scan_limit",
  "interactive_write_outcome_unknown",
  "interactive_write_restart_boundary",
  "invalid_glob",
  "invalid_regex",
  "invalid_tool_arguments",
  "max_concurrent_processes",
  "max_concurrent_terminal_sessions",
  "missing_argument",
  "missing_program",
  "output_limit",
  "oauth_scope",
  "oauth_scope_resolver_unavailable",
  "patch_context_mismatch",
  "patch_duplicate_path",
  "patch_malformed",
  "patch_postcondition_mismatch",
  "patch_rollback_failed",
  "patch_target_not_regular",
  "path_denied_by_policy",
  "portal_local_timeout",
  "portal_response",
  "target_missing_exec_profile",
  "unknown_command",
]);

const SAFE_ERROR_RESOURCES = new Set(["file_search", "process_output_spool"]);

export function auditErrorDiagnostics(error: HostSpanError): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    error_code: error.code,
    retryable: error.retryable,
  };
  const reason = error.details.reason;
  if (typeof reason === "string" && SAFE_ERROR_REASONS.has(reason)) metadata.error_reason = reason;
  if (reason === "portal_local_timeout" || reason === "portal_response") {
    if (["CreateSession", "SelectDevices", "SelectSources", "Start"].includes(error.details.portal_phase as string)) metadata.portal_phase = error.details.portal_phase;
    if (reason === "portal_response" && Number.isSafeInteger(error.details.portal_response) && Number(error.details.portal_response) >= 0) metadata.portal_response = error.details.portal_response;
  }
  if (reason === "oauth_scope") {
    const required = Array.isArray(error.details.required_scopes) ? error.details.required_scopes : [error.details.required_scope];
    const granted = Array.isArray(error.details.granted_scopes) ? error.details.granted_scopes : [];
    metadata.error_required_scopes = HOSTSPAN_OAUTH_SCOPES.filter((scope) => required.includes(scope));
    metadata.error_granted_scopes = HOSTSPAN_OAUTH_SCOPES.filter((scope) => granted.includes(scope));
  }
  const resource = error.details.resource;
  if (typeof resource === "string" && SAFE_ERROR_RESOURCES.has(resource)) metadata.error_resource = resource;
  if (error.code === "CURSOR_EXPIRED") {
    if (error.details.stream === "stdout" || error.details.stream === "stderr") metadata.error_stream = error.details.stream;
    for (const key of ["earliest_cursor", "latest_cursor", "stdout_earliest_cursor", "stderr_earliest_cursor"]) {
      const value = error.details[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) metadata[`error_${key}`] = value;
    }
  }
  return metadata;
}

// Record bounds and outcomes, never file/command/clipboard bodies or arbitrary error strings.
export function auditRequestDiagnostics(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["start_line", "end_line", "start_byte", "max_bytes", "max_entries", "max_matches", "wait_ms", "deadline_ms", "stdout_cursor", "stderr_cursor", "limit"]) {
    if (typeof input[key] === "number") result[key] = input[key];
  }
  if (typeof input.path === "string") result.path_hash = argumentHash({ target_id: input.target_id, path: input.path });
  // GUI schemas are strict, but retain only bounded identifiers and numeric controls here too.
  for (const key of ["session_id", "observation_id"]) {
    if (typeof input[key] === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input[key])) result[key] = input[key];
  }
  for (const key of ["x", "y", "dx", "dy"]) {
    if (typeof input[key] === "number" && Number.isFinite(input[key])) result[key] = input[key];
  }
  if (["left", "right", "middle"].includes(input.button as string)) result.button = input.button;
  if (input.action === "text" && typeof input.text === "string") result.text_bytes = Buffer.byteLength(input.text);
  if (typeof input.action === "string" && ["open", "observe", "close", "move", "click", "text", "key", "scroll"].includes(input.action)) result.action = input.action;
  return result;
}

export function auditResponseDiagnostics(result: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of ["state", "binary", "truncated", "truncated_before", "truncated_after", "returned_bytes", "returned_record_bytes", "match_count", "next_byte", "next_stdout_cursor", "next_stderr_cursor", "stdout_dropped_bytes", "stderr_dropped_bytes", "output_expired", "has_more_output", "exit_code", "input_delivered", "dispatched", "outcome_verified", "replayed", "observation_required", "coordinate_width", "coordinate_height"]) {
    const value = result[key];
    if (value === null || typeof value === "number" || typeof value === "boolean"
      || typeof value === "string" && ["accepted", "launching", "running", "succeeded", "completed", "failed", "cancelled", "timed_out", "orphaned", "unknown", "ready", "closed", "disabled", "awaiting_consent", "processing"].includes(value)) metadata[key] = value;
  }
  for (const key of ["session_id", "observation_id"]) {
    if (typeof result[key] === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result[key])) metadata[key] = result[key];
  }
  if (result.desktop_backend === "wayland-portal") metadata.desktop_backend = result.desktop_backend;
  if (result.desktop_scope === "monitor") metadata.desktop_scope = result.desktop_scope;
  if (result.window_attribution === "unavailable") metadata.window_attribution = result.window_attribution;
  if (typeof result.pipewire_node_id === "number" && Number.isSafeInteger(result.pipewire_node_id) && result.pipewire_node_id >= 0) metadata.pipewire_node_id = result.pipewire_node_id;
  if (result.returned_range && typeof result.returned_range === "object") {
    const range = result.returned_range as Record<string, unknown>;
    for (const key of ["start_line", "end_line", "start_byte", "end_byte", "bytes_scanned"]) {
      if (typeof range[key] === "number") metadata[`returned_${key}`] = range[key];
    }
  }
  for (const key of ["entries", "processes"]) if (Array.isArray(result[key])) metadata[`${key}_count`] = result[key].length;
  for (const key of ["stdout", "stderr"]) if (typeof result[key] === "string") metadata[`${key}_returned_bytes`] = Buffer.byteLength(result[key]);
  return metadata;
}
