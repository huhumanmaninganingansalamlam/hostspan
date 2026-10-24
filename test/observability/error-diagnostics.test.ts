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
    const scopes = auditErrorDiagnostics(new HostSpanError("SCOPE_DENIED", canary, false, {
      reason: "oauth_scope", required_scopes: ["hostspan.exec", canary], granted_scopes: [canary, "hostspan.read"],
    }));
    expect(scopes).toMatchObject({ error_required_scopes: ["hostspan.exec"], error_granted_scopes: ["hostspan.read"] });
    expect(JSON.stringify(scopes)).not.toContain(canary);
  });

  it("distinguishes portal responses from local setup expiry without inventing an OS response", () => {
    expect(auditErrorDiagnostics(new HostSpanError("INTERNAL_ERROR", "not logged", false, {
      reason: "portal_response", portal_phase: "Start", portal_response: 2,
    }))).toMatchObject({ error_reason: "portal_response", portal_phase: "Start", portal_response: 2 });
    const local = auditErrorDiagnostics(new HostSpanError("DEADLINE_EXCEEDED", "not logged", false, {
      reason: "portal_local_timeout", portal_phase: "CreateSession", portal_response: 2,
    }));
    expect(local).toMatchObject({ error_reason: "portal_local_timeout", portal_phase: "CreateSession" });
    expect(local).not.toHaveProperty("portal_response");
  });
});

it("records GUI location and delivery without screen, window-title, text or key content", () => {
  const session_id = "36a103f5-dbff-4377-8088-8d7802730c07";
  const observation_id = "20739df8-eb76-460d-bb7a-bfb48bf956e4";
  const secret = "HOSTSPAN_SECRET_CANARY_GUI";
  const request = auditRequestDiagnostics({ action: "click", session_id, observation_id,
    x: 512, y: 310, button: "left", text: secret, key: secret, window_title: secret });
  expect(request).toEqual({ action: "click", session_id, observation_id, x: 512, y: 310, button: "left" });
  const response = auditResponseDiagnostics({ session_id, observation_id, desktop_backend: "wayland-portal",
    desktop_scope: "monitor", pipewire_node_id: 73, window_attribution: "unavailable", dispatched: true,
    outcome_verified: false, image: secret, window_title: secret });
  expect(response).toEqual({ session_id, observation_id, desktop_backend: "wayland-portal", desktop_scope: "monitor",
    pipewire_node_id: 73, window_attribution: "unavailable", dispatched: true, outcome_verified: false });
  expect(auditRequestDiagnostics({ action: "text", text: "한글" })).toEqual({ action: "text", text_bytes: 6 });
  expect(auditRequestDiagnostics({ session_id: secret, observation_id: secret, x: NaN, y: Infinity })).toEqual({});
  expect(JSON.stringify({ request, response })).not.toContain(secret);
});
