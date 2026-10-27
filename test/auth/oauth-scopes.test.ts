import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createOAuthSetup, type OAuthService, type OAuthTokenResponse } from "../../src/auth/oauth-service.js";
import { ComputerInputSchema, PortalDesktop } from "../../src/computer/portal.js";
import { createRuntime, type HostSpanRuntime } from "../../src/runtime/create-runtime.js";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { HostSpanError } from "../../src/errors.js";
import { errorResult } from "../../src/mcp/result.js";
import { TOOL_NAMES, TOOLSET_HASH, toolsetDocument, type HostSpanToolHandlers } from "../../src/mcp/registry.js";
import { createHostSpanHttpServer } from "../../src/mcp/server.js";

const roots: string[] = [];
const RESOURCE = "https://mcp.example.com/mcp";
const REDIRECT = "http://127.0.0.1:44123/callback";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(computer = false) {
  const root = mkdtempSync(join(tmpdir(), "hostspan-oauth-scopes-"));
  roots.push(root);
  const targetRoot = join(root, "repo");
  mkdirSync(targetRoot, { recursive: true });
  const setup = createOAuthSetup(RESOURCE);
  const configPath = join(root, "config.yaml");
  const config: HostSpanConfig = {
    schema_version: 1,
    policy_epoch: 5,
    server: {
      listen_host: "127.0.0.1",
      listen_port: 39393,
      allowed_hosts: ["127.0.0.1", "mcp.example.com"],
      data_dir: join(root, "state"),
    },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: 16 * 1024 * 1024,
    },
    oauth: setup.config,
    targets: {
      test: {
        label: "OAuth scope test",
        provider: "local",
        root: targetRoot,
        capabilities: ["read"],
        deny_globs: [],
        ignore_globs: [],
      },
    },
    exec_profiles: {},
    ...(computer ? { computer: { backend: "wayland-portal" as const } } : {}),
  };
  writeConfigAtomic(configPath, config);
  const runtime = createRuntime(configPath);
  if (!runtime.oauth) throw new Error("OAuth runtime was not initialized.");
  return { runtime, approvalSecret: setup.approval_secret };
}

function issueToken(oauth: OAuthService, approvalSecret: string, scope?: string, existingClientId?: string): { clientId: string; token: OAuthTokenResponse } {
  const client = existingClientId ? { client_id: existingClientId } : oauth.registerClient({
    client_name: "scope-test",
    application_type: "native",
    redirect_uris: [REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  const verifier = `scope-test-verifier-${"x".repeat(48)}`;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  if (scope !== undefined) params.set("scope", scope);
  const prompt = oauth.beginAuthorization(params);
  const redirect = new URL(oauth.approveAuthorization(prompt.request_id, approvalSecret));
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error("OAuth authorization did not return a code.");
  const token = oauth.exchangeToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  );
  return { clientId: client.client_id, token };
}

function refreshToken(
  oauth: OAuthService,
  clientId: string,
  refreshTokenValue: string,
  scope?: string,
): OAuthTokenResponse {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    client_id: clientId,
    resource: RESOURCE,
  });
  if (scope !== undefined) form.set("scope", scope);
  return oauth.exchangeToken(form);
}

function modernMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "oauth-scope-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function fakeHandlers(calls: string[]): HostSpanToolHandlers {
  const result = (tool: string) => {
    calls.push(tool);
    return { tool };
  };
  return {
    computer: () => result("computer"),
    system_status: () => result("system_status"),
    target_list: () => result("target_list"),
    file_list: () => result("file_list"),
    file_read: () => result("file_read"),
    file_search: () => result("file_search"),
    file_patch: () => result("file_patch"),
    process_start: () => result("process_start"),
    process_poll: () => result("process_poll"),
    process_list: () => result("process_list"),
    process_write: () => result("process_write"),
    process_cancel: () => result("process_cancel"),
  };
}

function testApp(runtime: HostSpanRuntime, calls: string[], traces?: Array<Record<string, unknown>>) {
  const oauth = runtime.oauth;
  if (!oauth) throw new Error("OAuth runtime was not initialized.");
  const backends = new Map<string, "native" | "pty">([
    ["native-proc", "native"],
    ["pty-proc", "pty"],
  ]);
  return createHostSpanHttpServer({
    listen_host: "127.0.0.1",
    listen_port: 0,
    allowed_hosts: ["127.0.0.1", "mcp.example.com"],
    oauth,
    authorization: { ...runtime.authorization, processBackend: (processId) => backends.get(processId) },
    handlers: fakeHandlers(calls),
    responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: runtime.config.policy_epoch }),
    status: { health: () => ({ server_version: "test" }), readiness: () => ({ ready: true }) },
    ...(traces ? { trace: (event: string, metadata: Record<string, unknown>) => traces.push({ event, ...metadata }) } : {}),
  });
}

async function callTool(app: FastifyInstance, token: string, name: string, args: Record<string, unknown>, protocolVersion = "2026-07-28") {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      host: "mcp.example.com",
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": name,
      "mcp-protocol-version": protocolVersion,
    },
    payload: {
      jsonrpc: "2.0",
      id: `call-${name}-${uuidv7()}`,
      method: "tools/call",
      params: { name, arguments: args, ...(protocolVersion === "2026-07-28" ? { _meta: modernMeta() } : {}) },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers["www-authenticate"]).toBeUndefined();
  return response.json() as {
    result?: {
      resultType?: string;
      isError?: boolean;
      _meta?: { "mcp/www_authenticate"?: string[] };
      structuredContent?: Record<string, unknown>;
      content?: Array<{ type?: string; text?: string }>;
    };
  };
}

function expectAllowed(body: Awaited<ReturnType<typeof callTool>>, tool: string): void {
  expect(body.result?.isError).not.toBe(true);
  expect(body.result?.structuredContent).toMatchObject({ tool });
}

function expectScopeDenied(body: Awaited<ReturnType<typeof callTool>>, requiredScope?: string): void {
  expect(body.result?.isError).toBe(true);
  const text = body.result?.content?.[0]?.text;
  if (!text) throw new Error("scope denial did not include HostSpan error content");
  const payload = (body.result?.structuredContent ?? JSON.parse(text)) as { error?: { code?: string; details?: Record<string, unknown> } };
  expect(payload.error?.code).toBe("SCOPE_DENIED");
  expect(payload.error?.details).toMatchObject({ reason: "oauth_scope" });
  if (requiredScope) expect(payload.error?.details?.required_scope).toBe(requiredScope);
}

const patchArgs = () => ({
  idempotency_key: uuidv7(),
  target_id: "test",
  files: [
    {
      path: "x.txt",
      expected_sha256: "0".repeat(64),
      unified_diff: "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n",
    },
  ],
});

const startArgs = (tty: boolean) => ({
  idempotency_key: uuidv7(),
  target_id: "test",
  argv: ["node", "-e", "process.exit(0)"],
  cwd: ".",
  env: {},
  wait_ms: 0,
  deadline_ms: 1_000,
  max_output_bytes: 1_024,
  tty,
});

it("keeps invalid response waits distinct from insufficient scope without dispatch", async () => {
  const { runtime, approvalSecret } = fixture();
  const oauth = runtime.oauth;
  if (!oauth) throw new Error("OAuth runtime was not initialized.");
  const calls: string[] = [];
  const app = testApp(runtime, calls);
  try {
    expect(toolsetDocument().tools.find((tool) => tool.name === "process_start")?.input_schema).toMatchObject({
      properties: { wait_ms: { type: "integer", minimum: 0, maximum: 1_500, default: 1_200 } },
    });
    const exec = issueToken(oauth, approvalSecret, "hostspan.read hostspan.exec");
    const terminal = issueToken(oauth, approvalSecret, "hostspan.read hostspan.terminal", exec.clientId);
    for (const grant of [exec, terminal]) {
      const body = await callTool(app, grant.token.access_token, "process_start", { ...startArgs(false), wait_ms: 10_000 });
      expect(body.result).toMatchObject({ resultType: "complete", isError: true, structuredContent: { error: {
        code: "VALIDATION_FAILED", message: expect.stringMatching(/wait_ms.*1500/),
        details: { reason: "invalid_tool_arguments" },
      } } });
      expect(body.result?._meta?.["mcp/www_authenticate"]).toBeUndefined();
    }
    const legacy = await callTool(app, exec.token.access_token, "process_start", { ...startArgs(false), wait_ms: 10_000 }, "2025-11-25");
    expect(legacy.result).toMatchObject({ isError: true, structuredContent: { error: { code: "VALIDATION_FAILED" } } });
    expect(legacy.result?.resultType).toBeUndefined();
    expect(legacy.result?._meta?.["mcp/www_authenticate"]).toBeUndefined();
    const denied = await callTool(app, terminal.token.access_token, "process_start", { ...startArgs(false), wait_ms: 1_000 });
    expect(denied.result?.resultType).toBe("complete");
    expectScopeDenied(denied, "hostspan.exec");
    const challenge = denied.result?._meta?.["mcp/www_authenticate"];
    expect(challenge).toHaveLength(1);
    for (const value of ['error="insufficient_scope"', "hostspan.read", "hostspan.terminal", "hostspan.exec"]) {
      expect(challenge?.[0]).toContain(value);
    }
    expect(calls).toEqual([]);
    const allowed = await callTool(app, exec.token.access_token, "system_status", {});
    expectAllowed(allowed, "system_status");
    expect(allowed.result?.resultType).toBe("complete");
    expect(calls).toEqual(["system_status"]);
  } finally {
    await app.close();
    await runtime.close();
  }
});

it("preserves advertised granular grants and enforces exec separately from terminal", async () => {
  const { runtime, approvalSecret } = fixture();
  const oauth = runtime.oauth;
  if (!oauth) throw new Error("OAuth runtime was not initialized.");
  const calls: string[] = [];
  const app = testApp(runtime, calls);
  try {
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]) {
      const metadata = await app.inject({ method: "GET", url: path, headers: { host: "mcp.example.com" } });
      expect(metadata.statusCode).toBe(200);
      expect(metadata.json().scopes_supported).toEqual([
        "hostspan.computer", "hostspan.read", "hostspan.write", "hostspan.exec", "hostspan.terminal",
      ]);
    }
    // The static tool metadata requires OAuth; its argument-dependent scope is enforced on each call.
    expect(toolsetDocument().tools.find((tool) => tool.name === "process_start")?._meta.securitySchemes)
      .toEqual([{ type: "oauth2", scopes: [] }]);
    const scopes = ["hostspan.computer", "hostspan.read", "hostspan.write", "hostspan.terminal"];
    const grant = issueToken(oauth, approvalSecret, scopes.join(" "));
    expect(oauth.verifyAccessToken(grant.token.access_token)?.scopes).toEqual(scopes);
    const status = await callTool(app, grant.token.access_token, "system_status", {});
    expect(status.result?.structuredContent?.authorization).toMatchObject({ mode: "oauth", granted_scopes: scopes });
    const denied = await callTool(app, grant.token.access_token, "process_start", { ...startArgs(false), wait_ms: 1_000 });
    expectScopeDenied(denied, "hostspan.exec");
    expect(denied.result?._meta?.["mcp/www_authenticate"]?.[0]).toContain('error="insufficient_scope"');
    expect(calls).toEqual(["system_status"]);
    expectAllowed(await callTool(app, grant.token.access_token, "process_start", startArgs(true)), "process_start");
    expect(calls).toEqual(["system_status", "process_start"]);
  } finally {
    await app.close();
    await runtime.close();
  }
});

it("correlates early authentication, validation and scope rejects without retaining payloads", async () => {
  const { runtime, approvalSecret } = fixture();
  const oauth = runtime.oauth;
  if (!oauth) throw new Error("OAuth runtime was not initialized.");
  const calls: string[] = [];
  const traces: Array<Record<string, unknown>> = [];
  const app = testApp(runtime, calls, traces);
  const secret = "HOSTSPAN_SECRET_CANARY_EARLY_REJECT";
  const grant = issueToken(oauth, approvalSecret, "hostspan.read");
  const inject = (idempotency_key: string, wait_ms: number, authenticated = true) => app.inject({
    method: "POST", url: "/mcp",
    headers: { host: "mcp.example.com", accept: "application/json, text/event-stream",
      "content-type": "application/json", "mcp-method": "tools/call", "mcp-name": "process_start",
      "mcp-protocol-version": "2026-07-28",
      ...(authenticated ? { authorization: `Bearer ${grant.token.access_token}` } : {}),
    },
    payload: { jsonrpc: "2.0", id: secret, method: "tools/call", params: { name: "process_start",
      arguments: { ...startArgs(false), idempotency_key, wait_ms, argv: [secret], env: { SECRET: secret } }, _meta: modernMeta() } },
  });
  try {
    const unauthKey = uuidv7();
    const unauth = await inject(unauthKey, 10_000, false);
    expect(unauth.statusCode).toBe(401);
    expect(unauth.headers["www-authenticate"]).toContain("Bearer");
    const ingress = traces.find((row) => row.event === "transport.request" && row.idempotency_key === unauthKey);
    expect(ingress).toMatchObject({ transport_request_id: expect.any(String), tool: "process_start" });
    expect(traces).toContainEqual(expect.objectContaining({ event: "authorization.rejected",
      idempotency_key: unauthKey, transport_request_id: ingress?.transport_request_id,
      request_id: unauth.headers["x-hostspan-request-id"], stage: "authentication", http_status: 401 }));

    for (const wait_ms of [10_000, 1_000]) {
      const key = uuidv7();
      const response = await inject(key, wait_ms);
      expect(response.statusCode).toBe(200);
      expect(response.headers["www-authenticate"]).toBeUndefined();
      const result = response.json().result;
      const validation = wait_ms > 1_500;
      expect(result).toMatchObject({ resultType: "complete", isError: true, structuredContent: { error: {
        code: validation ? "VALIDATION_FAILED" : "SCOPE_DENIED",
      } } });
      expect(Boolean(result._meta?.["mcp/www_authenticate"])).toBe(!validation);
      expect(runtime.audit.recent()).toContainEqual(expect.objectContaining({ request_id: result.structuredContent.request_id,
        metadata: expect.objectContaining({ idempotency_key: key, tool: "process_start", stage: validation ? "validation" : "authorization" }) }));
      if (validation) {
        expect(response.headers["x-hostspan-request-id"]).toBe(result.structuredContent.request_id);
        expect(traces).toContainEqual(expect.objectContaining({ event: "validation.rejected", idempotency_key: key,
          request_id: result.structuredContent.request_id, transport_request_id: expect.any(String) }));
      }
    }
    await inject(secret, 10_000);
    expect(JSON.stringify({ traces, audit: runtime.audit.recent() })).not.toContain(secret);
    expect(calls).toEqual([]);
  } finally {
    await app.close();
    await runtime.close();
  }
});

describe("OAuth scope split", () => {
  it("defaults new grants to read and only allows refresh to preserve or narrow authority", async () => {
    const { runtime, approvalSecret } = fixture();
    const oauth = runtime.oauth;
    if (!oauth) throw new Error("OAuth runtime was not initialized.");
    try {
      expect(oauth.authorizationServerMetadata()).toMatchObject({
        scopes_supported: ["hostspan.computer", "hostspan.read", "hostspan.write", "hostspan.exec", "hostspan.terminal"],
      });
      expect(oauth.protectedResourceMetadata()).toMatchObject({
        scopes_supported: ["hostspan.computer", "hostspan.read", "hostspan.write", "hostspan.exec", "hostspan.terminal"],
      });

      const defaultGrant = issueToken(oauth, approvalSecret);
      expect(defaultGrant.token.scope).toBe("hostspan.read");
      expect(() =>
        refreshToken(oauth, defaultGrant.clientId, defaultGrant.token.refresh_token, "hostspan.read hostspan.exec"),
      ).toThrowError(expect.objectContaining({ code: "invalid_scope" }));

      const combined = issueToken(oauth, approvalSecret, "hostspan.read hostspan.write");
      const narrowed = refreshToken(oauth, combined.clientId, combined.token.refresh_token, "hostspan.read");
      expect(narrowed.scope).toBe("hostspan.read");

      expect(() => issueToken(oauth, approvalSecret, "hostspan")).toThrowError(
        expect.objectContaining({ redirect: expect.stringContaining("error=invalid_scope") }),
      );

      const granular = issueToken(oauth, approvalSecret, "hostspan.read");
      expect(() => refreshToken(oauth, granular.clientId, granular.token.refresh_token, "hostspan")).toThrowError(
        expect.objectContaining({ code: "invalid_scope" }),
      );

      const oldRefresh = "hs_refresh_legacy_scope";
      const now = Math.floor(Date.now() / 1000);
      runtime.oauthRepo.saveRefreshToken({
        token_hash: createHash("sha256").update(oldRefresh).digest("hex"),
        client_id: granular.clientId,
        scope: "hostspan",
        resource: RESOURCE,
        expires_at: now + 3600,
        revoked_at: null,
      });
      expect(() => refreshToken(oauth, granular.clientId, oldRefresh)).toThrowError(
        expect.objectContaining({ code: "invalid_scope" }),
      );

      const oldCode = "hs_code_legacy_scope";
      const verifier = "legacy-code-verifier";
      runtime.oauthRepo.saveAuthorizationCode({
        code_hash: createHash("sha256").update(oldCode).digest("hex"),
        client_id: granular.clientId,
        redirect_uri: REDIRECT,
        scope: "hostspan",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        resource: RESOURCE,
        expires_at: now + 300,
        used_at: null,
      });
      expect(() =>
        oauth.exchangeToken(
          new URLSearchParams({
            grant_type: "authorization_code",
            code: oldCode,
            client_id: granular.clientId,
            redirect_uri: REDIRECT,
            code_verifier: verifier,
            resource: RESOURCE,
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: "invalid_scope" }));
    } finally {
      await runtime.close();
    }
  });

  it("keeps the fixed tool list while separating read and write authority", async () => {
    const { runtime, approvalSecret } = fixture();
    const oauth = runtime.oauth;
    if (!oauth) throw new Error("OAuth runtime was not initialized.");
    const calls: string[] = [];
    const app = testApp(runtime, calls);
    try {
      const readGrant = issueToken(oauth, approvalSecret, "hostspan.read");
      const read = readGrant.token;
      const write = issueToken(oauth, approvalSecret, "hostspan.write").token;

      const listed = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          host: "mcp.example.com",
          authorization: `Bearer ${read.access_token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
        },
        payload: { jsonrpc: "2.0", id: "list", method: "tools/list", params: { _meta: modernMeta() } },
      });
      const listedBody = listed.json() as { result?: { tools?: Array<{ name: string; _meta?: { securitySchemes?: unknown } }> } };
      expect(listedBody.result?.tools?.map((tool) => tool.name)).toEqual(TOOL_NAMES);
      expect(listedBody.result?.tools?.find((tool) => tool.name === "computer")?._meta?.securitySchemes)
        .toEqual([{ type: "oauth2", scopes: ["hostspan.computer"] }]);

      expectAllowed(await callTool(app, read.access_token, "system_status", {}), "system_status");
      expectAllowed(await callTool(app, read.access_token, "process_list", { target_id: "test" }), "process_list");
      expectScopeDenied(await callTool(app, read.access_token, "file_patch", patchArgs()), "hostspan.write");
      expect(calls).not.toContain("file_patch");
      expect(runtime.audit.recent()).toContainEqual(expect.objectContaining({ process_id: null, metadata: expect.objectContaining({
        tool: "file_patch", stage: "authorization", error_reason: "oauth_scope",
        error_required_scopes: ["hostspan.write"], error_granted_scopes: ["hostspan.read"],
      }) }));
      const deniedDesktop = await callTool(app, read.access_token, "computer", { action: "open" });
      expectScopeDenied(deniedDesktop, "hostspan.computer");
      const challenges = deniedDesktop.result?._meta?.["mcp/www_authenticate"];
      expect(challenges).toHaveLength(1);
      expect(challenges?.[0]).toContain('error="insufficient_scope"');
      expect(challenges?.[0]).toContain('error_description="Additional HostSpan authorization is required."');
      expect(challenges?.[0]).toContain('scope="hostspan.read hostspan.computer"');
      expect(challenges?.[0]).toContain('resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"');
      expect(calls).not.toContain("computer");
      const policyDenied = errorResult({ toolset_hash: TOOLSET_HASH, policy_epoch: 5 },
        new HostSpanError("SCOPE_DENIED", "Desktop control is off."));
      expect(policyDenied.isError).toBe(true);
      expect(policyDenied._meta).toBeUndefined();
      const desktop = issueToken(oauth, approvalSecret, "hostspan.read hostspan.computer", readGrant.clientId).token;
      expect(oauth.verifyAccessToken(read.access_token)?.scopes).toEqual(["hostspan.read"]);
      expect(oauth.verifyAccessToken(desktop.access_token)?.scopes).toEqual(["hostspan.read", "hostspan.computer"]);
      expectAllowed(await callTool(app, desktop.access_token, "computer", { action: "open" }), "computer");

      // Reauthorization must preserve execution scopes, including through normal refresh.
      const previous = issueToken(oauth, approvalSecret, "hostspan.read hostspan.write hostspan.exec hostspan.terminal", readGrant.clientId).token;
      const needsComputer = await callTool(app, previous.access_token, "computer", { action: "open" });
      const requestedScope = /scope="([^"]+)"/.exec(needsComputer.result?._meta?.["mcp/www_authenticate"]?.[0] ?? "")?.[1];
      expect(requestedScope?.split(" ")).toEqual(["hostspan.read", "hostspan.write", "hostspan.exec", "hostspan.terminal", "hostspan.computer"]);
      const consented = issueToken(oauth, approvalSecret, requestedScope, readGrant.clientId).token;
      const refreshed = await app.inject({
        method: "POST", url: "/token",
        headers: { host: "mcp.example.com", "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ grant_type: "refresh_token", refresh_token: consented.refresh_token, client_id: readGrant.clientId }).toString(),
      });
      expect(refreshed.statusCode).toBe(200);
      const renewed = refreshed.json() as OAuthTokenResponse;
      expect(renewed.scope).toBe(requestedScope);
      for (const token of [consented, renewed]) {
        expectAllowed(await callTool(app, token.access_token, "computer", { action: "open" }), "computer");
        expectAllowed(await callTool(app, token.access_token, "process_start", startArgs(false)), "process_start");
      }

      expectAllowed(await callTool(app, write.access_token, "file_patch", patchArgs()), "file_patch");
      expectScopeDenied(
        await callTool(app, write.access_token, "file_read", { target_id: "test", path: "x.txt" }),
        "hostspan.read",
      );

      const oldAccess = "hs_access_legacy_scope";
      runtime.oauthRepo.saveAccessToken({
        token_hash: createHash("sha256").update(oldAccess).digest("hex"),
        client_id: readGrant.clientId,
        scope: "hostspan",
        resource: RESOURCE,
        expires_at: Math.floor(Date.now() / 1000) + 300,
        revoked_at: null,
      });
      expectScopeDenied(await callTool(app, oldAccess, "system_status", {}), "hostspan.read");
      expectScopeDenied(await callTool(app, oldAccess, "file_patch", patchArgs()), "hostspan.write");
    } finally {
      await app.close();
      await runtime.close();
    }
  });

  it("separates exec and terminal process authority including cancellation", async () => {
    const { runtime, approvalSecret } = fixture();
    const oauth = runtime.oauth;
    if (!oauth) throw new Error("OAuth runtime was not initialized.");
    const calls: string[] = [];
    const app = testApp(runtime, calls);
    try {
      const exec = issueToken(oauth, approvalSecret, "hostspan.exec").token;
      const terminal = issueToken(oauth, approvalSecret, "hostspan.terminal").token;

      expectAllowed(await callTool(app, exec.access_token, "process_start", startArgs(false)), "process_start");
      expectScopeDenied(await callTool(app, exec.access_token, "process_start", startArgs(true)), "hostspan.terminal");
      expectAllowed(
        await callTool(app, exec.access_token, "process_cancel", {
          idempotency_key: uuidv7(),
          process_id: "native-proc",
          grace_ms: 0,
        }),
        "process_cancel",
      );
      expectScopeDenied(
        await callTool(app, exec.access_token, "process_cancel", {
          idempotency_key: uuidv7(),
          process_id: "pty-proc",
          grace_ms: 0,
        }),
        "hostspan.terminal",
      );

      expectAllowed(await callTool(app, terminal.access_token, "process_start", startArgs(true)), "process_start");
      expectScopeDenied(await callTool(app, terminal.access_token, "process_start", startArgs(false)), "hostspan.exec");
      expectAllowed(
        await callTool(app, terminal.access_token, "process_write", {
          idempotency_key: uuidv7(),
          process_id: "pty-proc",
          chars: "x",
          control_keys: [],
        }),
        "process_write",
      );
      expectAllowed(
        await callTool(app, terminal.access_token, "process_cancel", {
          idempotency_key: uuidv7(),
          process_id: "pty-proc",
          grace_ms: 0,
        }),
        "process_cancel",
      );
      expectScopeDenied(
        await callTool(app, terminal.access_token, "process_cancel", {
          idempotency_key: uuidv7(),
          process_id: "native-proc",
          grace_ms: 0,
        }),
        "hostspan.exec",
      );
    } finally {
      await app.close();
      await runtime.close();
    }
  });
});

it("correlates verified GUI callers, screen and coordinates in existing audit across delivery, replay and rejection", async () => {
  const { runtime, approvalSecret } = fixture(true);
  const oauth = runtime.oauth;
  if (!oauth) throw new Error("OAuth runtime was not initialized.");
  const app = createHostSpanHttpServer({
    listen_host: "127.0.0.1", listen_port: 0, allowed_hosts: ["127.0.0.1", "mcp.example.com"],
    oauth: oauth, handlers: runtime.handlers, authorization: runtime.authorization,
    responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: 5 }),
    status: { health: () => ({}), readiness: () => ({ ready: true }) },
  });
  const session_id = uuidv7();
  const observation_id = uuidv7();
  const secret = "HOSTSPAN_SECRET_CANARY_GUI";
  const desktop = vi.spyOn(PortalDesktop.prototype, "run").mockImplementation(async (raw) => {
    const input = ComputerInputSchema.parse(raw);
    if (input.action === "observe") throw new HostSpanError("SCOPE_DENIED", "Sharing ended");
    return { state: "completed", session_id, observation_id: uuidv7(), desktop_backend: "wayland-portal",
      desktop_scope: "monitor", pipewire_node_id: 73, window_attribution: "unavailable",
      coordinate_width: 1680, coordinate_height: 1050, dispatched: true, outcome_verified: false,
      ...(input.action === "text" ? { replayed: true } : {}), image: Buffer.from(secret).toString("base64"), mime_type: "image/png", window_title: secret };
  });
  try {
    const first = issueToken(oauth, approvalSecret, "hostspan.computer");
    const second = issueToken(oauth, approvalSecret, "hostspan.computer");
    const read = issueToken(oauth, approvalSecret, "hostspan.read");
    const click = { action: "click", session_id, observation_id, x: 512, y: 310, idempotency_key: uuidv7() };
    const delivered = await callTool(app, first.token.access_token, "computer", click);
    expect(delivered).toMatchObject({ result: { structuredContent: { dispatched: true } } });
    const replay = await callTool(app, second.token.access_token, "computer", {
      action: "text", session_id, observation_id, text: secret, idempotency_key: uuidv7(),
    });
    const failed = await callTool(app, first.token.access_token, "computer", { action: "observe", session_id });
    const denied = await callTool(app, read.token.access_token, "computer", click);
    const invalid = await callTool(app, first.token.access_token, "computer", { ...click, x: -1 });
    const events = runtime.audit.recent();
    const event = (response: typeof delivered, type: string) => events.find((row) =>
      row.request_id === response.result?.structuredContent?.request_id && row.event_type === type);
    expect(event(delivered, "request.accepted")).toMatchObject({ metadata: {
      caller_mode: "oauth", oauth_client_id: first.clientId, action: "click", session_id, observation_id,
      x: 512, y: 310, button: "left",
    } });
    expect(event(delivered, "response.returned")).toMatchObject({ metadata: {
      caller_mode: "oauth", oauth_client_id: first.clientId, session_id, pipewire_node_id: 73,
      desktop_scope: "monitor", window_attribution: "unavailable", dispatched: true, outcome_verified: false,
    } });
    expect(event(replay, "response.returned")).toMatchObject({ metadata: {
      oauth_client_id: second.clientId, session_id, replayed: true, outcome_verified: false,
    } });
    expect(event(replay, "request.accepted")).toMatchObject({ metadata: { text_bytes: Buffer.byteLength(secret) } });
    expect(event(failed, "request.aborted")).toMatchObject({ metadata: {
      oauth_client_id: first.clientId, session_id, stage: "handler", error_code: "SCOPE_DENIED",
    } });
    expect(event(denied, "request.aborted")).toMatchObject({ metadata: {
      oauth_client_id: read.clientId, stage: "authorization", error_reason: "oauth_scope",
    } });
    expect(event(invalid, "request.aborted")).toMatchObject({ metadata: {
      oauth_client_id: first.clientId, stage: "validation", error_code: "VALIDATION_FAILED",
    } });
    expect(desktop).toHaveBeenCalledTimes(3);
    const serialized = JSON.stringify(events);
    for (const value of [secret, Buffer.from(secret).toString("base64"), first.token.access_token, second.token.access_token, first.token.refresh_token, approvalSecret]) {
      expect(serialized).not.toContain(value);
    }
    await runtime.handlers.computer({ action: "open" }, "local-gui-call");
    expect(runtime.audit.recent().find((row) => row.request_id === "local-gui-call")).toMatchObject({ metadata: { caller_mode: "local" } });
  } finally {
    desktop.mockRestore();
    await app.close();
    await runtime.close();
  }
});
