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
});
