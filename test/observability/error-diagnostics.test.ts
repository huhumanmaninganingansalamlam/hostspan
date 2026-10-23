import { describe, expect, it } from "vitest";
import { HostSpanError } from "../../src/errors.js";
import { auditErrorDiagnostics, auditRequestDiagnostics, auditResponseDiagnostics } from "../../src/observability/error-diagnostics.js";

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
    const request = auditRequestDiagnostics({ target_id: "local", path: canary, start_byte: 17, max_bytes: 5, action: "text", text: canary, argv: [canary], env: { SECRET: canary } });
    const response = auditResponseDiagnostics({ text: canary, stdout: canary, message: canary, image: canary, state: "failed", exit_code: 1, returned_bytes: 5, truncated_after: true, next_byte: 22, returned_range: { start_byte: 17, end_byte: 22 }, has_more_output: true });
    expect(request).toMatchObject({ start_byte: 17, max_bytes: 5, action: "text", path_hash: expect.any(String) });
    expect(response).toMatchObject({ state: "failed", exit_code: 1, returned_bytes: 5, truncated_after: true, next_byte: 22, returned_start_byte: 17, returned_end_byte: 22, stdout_returned_bytes: Buffer.byteLength(canary), has_more_output: true });
    expect(JSON.stringify({ request, response })).not.toContain(canary);
  });
});
