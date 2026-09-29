import { describe, expect, it } from "vitest";
import { HostSpanError } from "../../src/errors.js";
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

  it.each([
    "patch_context_mismatch",
    "patch_duplicate_path",
    "patch_malformed",
    "patch_postcondition_mismatch",
    "patch_rollback_failed",
    "patch_target_not_regular",
  ])("projects bounded patch reason %s without patch content", (reason) => {
    const error = new HostSpanError("PATCH_REJECTED", "private patch message", false, {
      reason,
      path: "/private/project",
      unified_diff: "private file content",
    });
    expect(auditErrorDiagnostics(error)).toEqual({ error_code: "PATCH_REJECTED", retryable: false, error_reason: reason });
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

});
