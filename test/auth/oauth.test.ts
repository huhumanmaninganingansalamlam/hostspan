import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createOAuthSetup } from "../../src/auth/oauth-service.js";
import { createRuntime, main } from "../../src/cli/index.js";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { TOOL_NAMES, TOOLSET_HASH } from "../../src/mcp/registry.js";
import { createHostSpanHttpServer } from "../../src/mcp/server.js";
import { DB_SCHEMA_VERSION, openDatabase } from "../../src/state/database.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(maxRegisteredClients = 100) {
  const root = mkdtempSync(join(tmpdir(), "hostspan-oauth-"));
  roots.push(root);
  const targetRoot = join(root, "repo");
  mkdirSync(targetRoot, { recursive: true });
  const setup = createOAuthSetup("https://mcp.example.com/mcp");
  setup.config.max_registered_clients = maxRegisteredClients;
  const configPath = join(root, "config.yaml");
  const config: HostSpanConfig = {
    schema_version: 1,
    policy_epoch: 4,
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
      local: {
        label: "OAuth target",
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
  return { configPath, approvalSecret: setup.approval_secret };
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function modernMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "oauth-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

describe("OAuth protected MCP", () => {
  it("keeps the approval credential out of config/stdout and stores it in a mode-0600 local file", async () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-oauth-cli-"));
    roots.push(root);
    const configPath = join(root, "config", "config.yaml");
    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await main(["init", "--config", configPath])).toBe(0);
      captured = "";
      expect(
        await main([
          "oauth",
          "init",
          "--public-url",
          "https://mcp.example.com/mcp",
          "--config",
          configPath,
        ]),
      ).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }

    const result = JSON.parse(captured) as { approval_secret_file: string };
    expect(result.approval_secret_file).toBe(join(root, "config", "oauth-approval-secret"));
    expect(existsSync(result.approval_secret_file)).toBe(true);
    if (process.platform !== "win32") expect(statSync(result.approval_secret_file).mode & 0o777).toBe(0o600);
    const credential = readFileSync(result.approval_secret_file, "utf8").trim();
    expect(credential).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(captured).not.toContain(credential);
    expect(readFileSync(configPath, "utf8")).not.toContain(credential);
  });

  it("migrates an existing schema-1 database to the OAuth schema with a backup", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-oauth-migration-"));
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = new Database(path);
    legacy.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    legacy.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run("schema_version", "1");
    legacy.close();

    const db = openDatabase(path);
    try {
      const version = db.prepare("SELECT value FROM meta WHERE key=?").get("schema_version") as { value: string };
      expect(Number(version.value)).toBe(DB_SCHEMA_VERSION);
      const oauthTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type=? AND name=?")
        .get("table", "oauth_access_tokens") as { name: string } | undefined;
      expect(oauthTable?.name).toBe("oauth_access_tokens");
      expect(existsSync(`${path}.pre-migration.bak`)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("bounds public client registration without permanent inactive-client lockout", async () => {
    const { configPath } = fixture(2);
    const runtime = createRuntime(configPath);
    if (!runtime.oauth) throw new Error("OAuth runtime was not initialized.");
    const app = createHostSpanHttpServer({
      listen_host: "127.0.0.1",
      listen_port: 0,
      allowed_hosts: ["127.0.0.1", "mcp.example.com"],
      oauth: runtime.oauth,
      handlers: runtime.handlers,
      responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: runtime.config.policy_epoch }),
      status: { health: () => ({ server_version: "test" }), readiness: () => ({ ready: true }) },
    });
    try {
      for (let index = 0; index < 3; index += 1) {
        const registered = await app.inject({
          method: "POST",
          url: "/register",
          headers: { host: "mcp.example.com", "content-type": "application/json" },
          payload: {
            client_name: `inactive-${index}`,
            application_type: "web",
            redirect_uris: [`https://client${index}.example/callback`],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          },
        });
        expect(registered.statusCode).toBe(201);
      }
      expect(runtime.oauthRepo.clientCount()).toBe(2);
    } finally {
      await app.close();
      runtime.close();
    }
  });

  it("runs authorization-code PKCE, bearer MCP, and refresh rotation", async () => {
    const { configPath, approvalSecret } = fixture();
    expect(readFileSync(configPath, "utf8")).not.toContain(approvalSecret);
    const runtime = createRuntime(configPath);
    if (!runtime.oauth) throw new Error("OAuth runtime was not initialized.");
    const oauth = runtime.oauth;
    const app = createHostSpanHttpServer({
      listen_host: "127.0.0.1",
      listen_port: 0,
      allowed_hosts: ["127.0.0.1", "mcp.example.com"],
      oauth,
      handlers: runtime.handlers,
      responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: runtime.config.policy_epoch }),
      status: {
        health: () => ({ server_version: "test" }),
        readiness: () => ({ ready: true }),
      },
    });
    const host = { host: "mcp.example.com" };
    try {
      const denied = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          ...host,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
        },
        payload: { jsonrpc: "2.0", id: "denied", method: "tools/list", params: { _meta: modernMeta() } },
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers["www-authenticate"]).toContain("oauth-protected-resource/mcp");

      const resourceMetadata = await app.inject({
        method: "GET",
        url: "/.well-known/oauth-protected-resource/mcp",
        headers: host,
      });
      expect(resourceMetadata.statusCode).toBe(200);
      expect(resourceMetadata.json()).toMatchObject({
        resource: "https://mcp.example.com/mcp",
        authorization_servers: ["https://mcp.example.com/"],
        scopes_supported: ["hostspan"],
      });

      const serverMetadata = await app.inject({
        method: "GET",
        url: "/.well-known/oauth-authorization-server",
        headers: host,
      });
      expect(serverMetadata.json()).toMatchObject({
        issuer: "https://mcp.example.com/",
        authorization_endpoint: "https://mcp.example.com/authorize",
        token_endpoint: "https://mcp.example.com/token",
        registration_endpoint: "https://mcp.example.com/register",
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["hostspan"],
      });
      expect(serverMetadata.json()).not.toHaveProperty("authorization_response_iss_parameter_supported");

      const registered = await app.inject({
        method: "POST",
        url: "/register",
        headers: { ...host, "content-type": "application/json" },
        payload: {
          client_name: "ChatGPT test",
          application_type: "web",
          redirect_uris: ["https://client.example/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
      });
      expect(registered.statusCode).toBe(201);
      expect(registered.headers.pragma).toBe("no-cache");
      const client = registered.json() as { client_id: string };

      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const authorizeQuery = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://client.example/callback",
        scope: "hostspan",
        state: "state-123",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: "https://mcp.example.com/mcp",
      });
      const authorize = await app.inject({
        method: "GET",
        url: `/authorize?${authorizeQuery.toString()}`,
        headers: host,
      });
      expect(authorize.statusCode).toBe(200);
      const requestId = /name="request_id" value="([^"]+)"/.exec(authorize.body)?.[1];
      expect(requestId).toMatch(/^hs_authreq_/);

      const secondAuthorizeQuery = new URLSearchParams(authorizeQuery);
      secondAuthorizeQuery.set("state", "state-parallel");
      const secondAuthorize = await app.inject({
        method: "GET",
        url: `/authorize?${secondAuthorizeQuery.toString()}`,
        headers: host,
      });
      expect(secondAuthorize.statusCode).toBe(200);
      const secondRequestId = /name="request_id" value="([^"]+)"/.exec(secondAuthorize.body)?.[1];
      expect(secondRequestId).toMatch(/^hs_authreq_/);
      expect(secondRequestId).not.toBe(requestId);

      const wrongApproval = await app.inject({
        method: "POST",
        url: "/authorize",
        headers: { ...host, "content-type": "application/x-www-form-urlencoded" },
        payload: form({ request_id: requestId ?? "", approval_secret: "wrong" }),
      });
      expect(wrongApproval.statusCode).toBe(302);
      const wrongApprovalCallback = new URL(String(wrongApproval.headers.location));
      expect(wrongApprovalCallback.searchParams.get("error")).toBe("access_denied");
      expect(wrongApprovalCallback.searchParams.get("state")).toBe("state-123");
      expect(wrongApprovalCallback.searchParams.has("iss")).toBe(false);

      const approved = await app.inject({
        method: "POST",
        url: "/authorize",
        headers: { ...host, "content-type": "application/x-www-form-urlencoded" },
        payload: form({ request_id: requestId ?? "", approval_secret: approvalSecret }),
      });
      expect(approved.statusCode).toBe(302);
      const callback = new URL(String(approved.headers.location));
      expect(callback.origin + callback.pathname).toBe("https://client.example/callback");
      expect(callback.searchParams.get("state")).toBe("state-123");
      expect(callback.searchParams.has("iss")).toBe(false);
      const firstCode = callback.searchParams.get("code") ?? "";
      expect(firstCode).toMatch(/^code-[0-9a-f-]{36}$/);

      const duplicateApproval = await app.inject({
        method: "POST",
        url: "/authorize",
        headers: { ...host, "content-type": "application/x-www-form-urlencoded" },
        payload: form({ request_id: requestId ?? "", approval_secret: approvalSecret }),
      });
      expect(duplicateApproval.statusCode).toBe(302);
      const duplicateCallback = new URL(String(duplicateApproval.headers.location));
      expect(duplicateCallback.searchParams.get("state")).toBe("state-123");
      expect(duplicateCallback.searchParams.has("iss")).toBe(false);
      const code = duplicateCallback.searchParams.get("code") ?? "";
      expect(code).not.toBe(firstCode);

      const parallelApproval = await app.inject({
        method: "POST",
        url: "/authorize",
        headers: { ...host, "content-type": "application/x-www-form-urlencoded" },
        payload: form({ request_id: secondRequestId ?? "", approval_secret: approvalSecret }),
      });
      expect(parallelApproval.statusCode).toBe(302);
      expect(new URL(String(parallelApproval.headers.location)).searchParams.get("state")).toBe("state-parallel");

      const wrongPkce = await app.inject({
        method: "POST",
        url: "/token",
        headers: { ...host, "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: "https://client.example/callback",
          code_verifier: "wrong-verifier-that-must-not-consume-the-code",
          resource: "https://mcp.example.com/mcp",
        }),
      });
      expect(wrongPkce.statusCode).toBe(400);
      expect(wrongPkce.headers.pragma).toBe("no-cache");
      expect(wrongPkce.json()).toMatchObject({ error: "invalid_grant" });

      const token = await app.inject({
        method: "POST",
        url: "/token",
        headers: { ...host, "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: "https://client.example/callback",
          code_verifier: verifier,
          resource: "https://mcp.example.com/mcp",
        }),
      });
      expect(token.statusCode).toBe(200);
      expect(token.headers.pragma).toBe("no-cache");
      const tokenBody = token.json() as { access_token: string; refresh_token: string; expires_in: number };
      expect(tokenBody.access_token).toMatch(/^hs_access_/);
      expect(tokenBody.refresh_token).toMatch(/^hs_refresh_/);
      expect(tokenBody.expires_in).toBeGreaterThan(0);

      const listed = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          ...host,
          authorization: `Bearer ${tokenBody.access_token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
        },
        payload: { jsonrpc: "2.0", id: "allowed", method: "tools/list", params: { _meta: modernMeta() } },
      });
      expect(listed.statusCode).toBe(200);
      const listedBody = listed.json() as { result?: { tools?: Array<{ name: string }> } };
      expect(listedBody.result?.tools?.map((tool) => tool.name)).toEqual(TOOL_NAMES);

      const refreshed = await app.inject({
        method: "POST",
        url: "/token",
        headers: { ...host, "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "refresh_token",
          refresh_token: tokenBody.refresh_token,
          client_id: client.client_id,
        }),
      });
      expect(refreshed.statusCode).toBe(200);
      const refreshedBody = refreshed.json() as { access_token: string; refresh_token: string };
      expect(refreshedBody.access_token).not.toBe(tokenBody.access_token);
      expect(refreshedBody.refresh_token).not.toBe(tokenBody.refresh_token);

      const replayedRefresh = await app.inject({
        method: "POST",
        url: "/token",
        headers: { ...host, "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "refresh_token",
          refresh_token: tokenBody.refresh_token,
          client_id: client.client_id,
        }),
      });
      expect(replayedRefresh.statusCode).toBe(400);
      expect(replayedRefresh.json()).toMatchObject({ error: "invalid_grant" });
    } finally {
      await app.close();
      runtime.close();
    }
  });

});
