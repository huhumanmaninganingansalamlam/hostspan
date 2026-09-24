import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createOAuthSetup, type OAuthService, type OAuthTokenResponse } from "../../src/auth/oauth-service.js";
import { createRuntime, type HostSpanRuntime } from "../../src/runtime/create-runtime.js";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { TOOL_NAMES, TOOLSET_HASH, type HostSpanToolHandlers } from "../../src/mcp/registry.js";
import { createHostSpanHttpServer } from "../../src/mcp/server.js";

const roots: string[] = [];
const RESOURCE = "https://mcp.example.com/mcp";
const REDIRECT = "http://127.0.0.1:44123/callback";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
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
  };
  writeConfigAtomic(configPath, config);
  const runtime = createRuntime(configPath);
  if (!runtime.oauth) throw new Error("OAuth runtime was not initialized.");
  return { runtime, approvalSecret: setup.approval_secret };
}

function issueToken(oauth: OAuthService, approvalSecret: string, scope?: string): { clientId: string; token: OAuthTokenResponse } {
  const client = oauth.registerClient({
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
    system_status: () => result("system_status"),
    target_list: () => result("target_list"),
    file_list: () => result("file_list"),
    file_read: () => result("file_read"),
    file_search: () => result("file_search"),
    file_patch: () => result("file_patch"),
    process_start: () => result("process_start"),
    process_poll: () => result("process_poll"),
    process_write: () => result("process_write"),
    process_cancel: () => result("process_cancel"),
  };
}

function testApp(runtime: HostSpanRuntime, calls: string[]) {
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
    authorization: { processBackend: (processId) => backends.get(processId) },
    handlers: fakeHandlers(calls),
    responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: runtime.config.policy_epoch }),
    status: { health: () => ({ server_version: "test" }), readiness: () => ({ ready: true }) },
  });
}

async function callTool(app: FastifyInstance, token: string, name: string, args: Record<string, unknown>) {
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
      "mcp-protocol-version": "2026-07-28",
    },
    payload: {
      jsonrpc: "2.0",
      id: `call-${name}-${uuidv7()}`,
      method: "tools/call",
      params: { name, arguments: args, _meta: modernMeta() },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as {
    result?: {
      isError?: boolean;
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
  const payload = JSON.parse(text) as { error?: { code?: string; details?: Record<string, unknown> } };
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

describe("OAuth scope split", () => {
  it("defaults new grants to read and only allows refresh to preserve or narrow authority", async () => {
    const { runtime, approvalSecret } = fixture();
    const oauth = runtime.oauth;
    if (!oauth) throw new Error("OAuth runtime was not initialized.");
    try {
      expect(oauth.authorizationServerMetadata()).toMatchObject({
        scopes_supported: ["hostspan.read", "hostspan.write", "hostspan.exec", "hostspan.terminal"],
      });
      expect(oauth.protectedResourceMetadata()).toMatchObject({
        scopes_supported: ["hostspan.read", "hostspan.write", "hostspan.exec", "hostspan.terminal"],
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
      const listedBody = listed.json() as { result?: { tools?: Array<{ name: string }> } };
      expect(listedBody.result?.tools?.map((tool) => tool.name)).toEqual(TOOL_NAMES);

      expectAllowed(await callTool(app, read.access_token, "system_status", {}), "system_status");
      expectScopeDenied(await callTool(app, read.access_token, "file_patch", patchArgs()), "hostspan.write");
      expect(calls).not.toContain("file_patch");

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
