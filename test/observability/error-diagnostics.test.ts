import { describe, expect, it } from "vitest";
import { HostSpanError } from "../../src/mcp/errors.js";
import { auditErrorDiagnostics } from "../../src/observability/error-diagnostics.js";

describe("audit error diagnostics", () => {
  it("keeps only explicitly safe diagnostic fields", () => {
    const error = new HostSpanError("VALIDATION_FAILED", "sensitive message", false, {
      reason: "invalid_regex",
      resource: "file_search",
      path: "/private/project",
      query: "secret-pattern",
    });

    expect(auditErrorDiagnostics(error)).toEqual({
      error_code: "VALIDATION_FAILED",
      retryable: false,
      error_reason: "invalid_regex",
      error_resource: "file_search",
    });
  });

  it("drops arbitrary detail values even when they look diagnostic", () => {
    const canary = "HOSTSPAN_SECRET_CANARY_DO_NOT_LEAK_12345";
    const error = new HostSpanError("INTERNAL_ERROR", canary, true, {
      reason: canary,
      resource: "private_database",
      token: canary,
    });

    const metadata = auditErrorDiagnostics(error);
    expect(metadata).toEqual({ error_code: "INTERNAL_ERROR", retryable: true });
    expect(JSON.stringify(metadata)).not.toContain(canary);
  });

  it("recognizes policy reason codes without exposing rejected input", () => {
    const error = new HostSpanError("SCOPE_DENIED", "Program is not allowed: private-tool", false, {
      reason: "program_not_allowed",
      program: "private-tool",
    });

    expect(auditErrorDiagnostics(error)).toEqual({
      error_code: "SCOPE_DENIED",
      retryable: false,
      error_reason: "program_not_allowed",
    });
  });

  it("records Git saturation as a safe resource without queue internals", () => {
    const error = new HostSpanError("SERVER_BUSY", "Git inspection capacity is saturated.", true, {
      resource: "git_changes",
      reason: "capacity_saturated",
      active: 4,
      queued: 8,
      repository: "/private/repo",
    });

    expect(auditErrorDiagnostics(error)).toEqual({
      error_code: "SERVER_BUSY",
      retryable: true,
      error_reason: "capacity_saturated",
      error_resource: "git_changes",
    });
  });

  it("records the safe Git filter policy reason without leaking repository details", () => {
    const error = new HostSpanError("POLICY_UNENFORCEABLE", "private filter command", false, {
      reason: "git_content_filter_unsafe",
      filter_command: "/private/repo/filter.sh",
      filtered_path_count: 2,
    });

    expect(auditErrorDiagnostics(error)).toEqual({
      error_code: "POLICY_UNENFORCEABLE",
      retryable: false,
      error_reason: "git_content_filter_unsafe",
    });
  });

  it("records normalized output classifications without exposing quantitative backend details", () => {
    const error = new HostSpanError("OUTPUT_LIMIT", "bounded output", false, {
      resource: "git_attributes",
      reason: "output_limit",
      limit_bytes: 4 * 1024 * 1024,
      observed_bytes: 5 * 1024 * 1024,
      max_attribute_bytes: 4 * 1024 * 1024,
    });

    expect(auditErrorDiagnostics(error)).toEqual({
      error_code: "OUTPUT_LIMIT",
      retryable: false,
      error_reason: "output_limit",
      error_resource: "git_attributes",
    });
  });
});
