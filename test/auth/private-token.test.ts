import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { PrivateTokenStore, parsePrivateTokenScopes } from "../../src/auth/private-token.js";
import { main } from "../../src/cli/index.js";
import { HostSpanConfigSchema, type HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { toolsetHash, type HostSpanToolHandlers } from "../../src/mcp/registry.js";
import { createHostSpanHttpServer, createMcpServer } from "../../src/mcp/server.js";
import { createRuntime } from "../../src/runtime/create-runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hostspan-private-token-"));
  roots.push(root);
  const targetRoot = join(root, "target");
  mkdirSync(targetRoot, { recursive: true });
  const configPath = join(root, "config.yaml");
  const config: HostSpanConfig = {
    schema_version: 1,
    policy_epoch: 12,
    server: {
      listen_host: "127.0.0.1",
      listen_port: 39393,
      data_dir: join(root, "state"),
    },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: 16 * 1024 * 1024,
    },
    authentication: { mode: "private_token" },
    targets: { test: {
      label: "Private token fixture",
      provider: "local",
      root: targetRoot,
      capabilities: ["read"],
      deny_globs: [],
      ignore_globs: [],
    } },
    exec_profiles: {},
  };
  writeConfigAtomic(configPath, config);
  return { root, configPath, config };
}

function handlers(calls: string[]): HostSpanToolHandlers {
  const record = (name: string) => {
    calls.push(name);
    return { name };
  };
  return {
    system_status: () => record("system_status"),
    target_list: () => record("target_list"),
    file_list: () => record("file_list"),
    file_read: () => record("file_read"),
    file_search: () => record("file_search"),
    file_patch: () => record("file_patch"),
    process_start: () => record("process_start"),
    process_list: () => record("process_list"),
    process_poll: () => record("process_poll"),
    process_write: () => record("process_write"),
    process_cancel: () => record("process_cancel"),
    computer: () => record("computer"),
  };
}

function request(app: FastifyInstance, rpcMethod: string, token?: string, toolName?: string, args: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      host: "127.0.0.1",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": rpcMethod,
      ...(toolName ? { "mcp-name": toolName } : {}),
      ...extraHeaders,
    },
    payload: {
      jsonrpc: "2.0",
      id: uuidv7(),
      method: rpcMethod,
      params: {
        ...(toolName ? { name: toolName, arguments: args } : {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "private-token-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
  });
}

describe("private token lifecycle", () => {
  it("stores only hashes, rotates atomically, revokes immediately, and bounds last-used updates", () => {
    const { config } = fixture();
    const store = new PrivateTokenStore(config.server.data_dir);
    try {
      let first = "";
      const issued = store.issue("client-a", ["hostspan.read"], (secret) => { first = secret; });
      expect(first).toMatch(/^hsp_[A-Za-z0-9_-]{43}$/);
      expect(store.verifyAuthorizationHeader(`Bearer ${first}`)?.token_id).toBe(issued.token_id);
      expect(store.verifyAuthorizationHeader(`bearer ${first}`)?.token_id).toBe(issued.token_id);
      expect(store.verifyAuthorizationHeader(`bEaReR   ${first}`)?.token_id).toBe(issued.token_id);
      expect(store.verifyAuthorizationHeader(`Basic ${first}`)).toBeUndefined();
      expect(store.verifyAuthorizationHeader(`Bearer ${first} extra`)).toBeUndefined();
      expect(readFileSync(store.path).includes(first)).toBe(false);
      if (process.platform !== "win32") expect(statSync(store.path).mode & 0o777).toBe(0o600);
      expect(store.list()[0]).not.toHaveProperty("secret_hash");
      expect(store.list()[0]).not.toHaveProperty("token");
      expect(() => store.rotate(issued.token_id, () => { throw new Error("delivery failed"); })).toThrow("delivery failed");
      expect(store.verifyAuthorizationHeader(`Bearer ${first}`)).toBeDefined();
      let second = "";
      expect(store.rotate(issued.token_id, (secret) => { second = secret; })?.token_id).toBe(issued.token_id);
      expect(store.verifyAuthorizationHeader(`Bearer ${first}`)).toBeUndefined();
      expect(store.verifyAuthorizationHeader(`Bearer ${second}`)).toBeDefined();
      expect(store.verifyAuthorizationHeader(`Bearer ${second}`)).toBeDefined();
      expect(store.list()[0]?.last_used_at).toBeTypeOf("number");
      expect(store.revoke(issued.token_id)).toBe(true);
      expect(store.revoke(issued.token_id)).toBe(false);
      expect(store.verifyAuthorizationHeader(`Bearer ${second}`)).toBeUndefined();
      expect(store.list()[0]?.revoked_at).toBeTypeOf("number");
    } finally {
      store.close();
    }
  });

  it("validates scopes and never grants default scopes", () => {
    expect(parsePrivateTokenScopes("hostspan.write,hostspan.read,hostspan.read")).toEqual(["hostspan.read", "hostspan.write"]);
    expect(() => parsePrivateTokenScopes("")).toThrow();
    expect(() => parsePrivateTokenScopes("hostspan.admin")).toThrow();
    const { config } = fixture();
    const store = new PrivateTokenStore(config.server.data_dir);
    try {
      expect(() => store.issue("bad", [], () => {})).toThrow();
      expect(() => store.issue("bad\nname", ["hostspan.read"], () => {})).toThrow();
      expect(store.list()).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

describe("private token MCP HTTP authentication", () => {
  it("rejects missing/invalid/revoked credentials before SDK and applies tool scopes", async () => {
    const { configPath } = fixture();
    const runtime = createRuntime(configPath);
    const store = runtime.privateTokens;
    if (!store) throw new Error("private token runtime is absent");
    let credential = "";
    const issued = store.issue("client", ["hostspan.read"], (secret) => { credential = secret; });
    const calls: string[] = [];
    const app = createHostSpanHttpServer({
      listen_host: "127.0.0.1",
      listen_port: 0,
      authenticationMode: "private_token",
      privateTokens: store,
      handlers: handlers(calls),
      responseContext: () => ({ toolset_hash: toolsetHash("private_token"), policy_epoch: 12 }),
      status: { health: () => ({}), readiness: () => ({ ready: true }) },
    });
    try {
      const noToken = await request(app, "tools/list");
      expect(noToken.statusCode).toBe(401);
      expect(noToken.headers["www-authenticate"]).toBeUndefined();
      expect(noToken.body).not.toContain("oauth");
      expect((await request(app, "tools/list", `hsp_${"x".repeat(43)}`)).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/mcp" })).statusCode).toBe(401);
      expect(calls).toEqual([]);
      const listing = await request(app, "tools/list", credential);
      expect(listing.statusCode, listing.body).toBe(200);
      const mixedCase = await request(app, "tools/list", undefined, undefined, {}, { authorization: `bEaReR   ${credential}` });
      expect(mixedCase.statusCode, mixedCase.body).toBe(200);
      const tools = listing.json().result.tools as Array<{ securitySchemes: Array<{ type: string; scheme?: string }> }>;
      expect(tools.length).toBeGreaterThan(0);
      expect(tools[0]?.securitySchemes).toEqual([{ type: "http", scheme: "bearer" }]);
      expect(listing.body).not.toContain("oauth2");
      const read = await request(app, "tools/call", credential, "system_status");
      expect(read.statusCode, read.body).toBe(200);
      expect(read.body).toContain("private_token");
      expect(calls).toEqual(["system_status"]);
      const denied = await request(app, "tools/call", credential, "computer", { action: "open" });
      expect(denied.statusCode, denied.body).toBe(200);
      expect(denied.body).toContain("SCOPE_DENIED");
      expect(calls).toEqual(["system_status"]);
      store.revoke(issued.token_id);
      expect((await request(app, "tools/list", credential)).statusCode).toBe(401);
    } finally {
      await app.close();
      await runtime.close();
    }
  });

  it("requires an explicit protected transport and exact host for remote private serving", async () => {
    const { config } = fixture();
    const store = new PrivateTokenStore(config.server.data_dir);
    const options = {
      listen_host: "10.30.40.50",
      listen_port: 0,
      allowed_hosts: ["10.30.40.50"],
      authenticationMode: "private_token" as const,
      privateTokens: store,
      handlers: handlers([]),
      responseContext: () => ({ toolset_hash: toolsetHash("private_token"), policy_epoch: 1 }),
      status: { health: () => ({}), readiness: () => ({ ready: true }) },
    };
    try {
      expect(() => createHostSpanHttpServer(options)).toThrow(/encrypted private transport/);
      expect(() => createHostSpanHttpServer({ ...options, listen_host: "0.0.0.0", protected_transport: "encrypted_private_network" })).toThrow(/exact IP bind/);
      const app = createHostSpanHttpServer({ ...options, protected_transport: "encrypted_private_network" });
      try {
        let credential = "";
        store.issue("remote-fixture", ["hostspan.read"], (secret) => { credential = secret; });
        const correctHost = { host: "10.30.40.50:39393" };
        const allowed = await request(app, "tools/list", credential, undefined, {}, correctHost);
        expect(allowed.statusCode, allowed.body).toBe(200);
        expect((await request(app, "tools/list", undefined, undefined, {}, correctHost)).statusCode).toBe(401);
        expect((await request(app, "tools/list", credential, undefined, {}, { host: "10.30.40.51" })).statusCode).toBe(403);
        expect((await request(app, "tools/list", credential, undefined, {}, {
          ...correctHost, origin: "https://unapproved.example",
        })).statusCode).toBe(403);
        expect((await request(app, "tools/list", credential, undefined, {}, {
          ...correctHost, origin: "http://10.30.40.50:39393",
        })).statusCode).toBe(200);
      } finally {
        await app.close();
      }
      expect(HostSpanConfigSchema.safeParse({
        ...config,
        server: { ...config.server, listen_host: "10.30.40.50", allowed_hosts: ["10.30.40.50"] },
        authentication: { mode: "private_token", protected_transport: "encrypted_private_network" },
      }).success).toBe(true);
      expect(HostSpanConfigSchema.safeParse({
        ...config,
        server: { ...config.server, listen_host: "10.30.40.50", allowed_hosts: ["10.30.40.50"] },
        authentication: { mode: "private_token" },
      }).success).toBe(false);
      expect(HostSpanConfigSchema.safeParse({
        ...config,
        server: { ...config.server, listen_host: "0.0.0.0", allowed_hosts: ["10.30.40.50"] },
        authentication: { mode: "private_token", protected_transport: "encrypted_private_network" },
      }).success).toBe(false);
    } finally {
      store.close();
    }
  });

  it("fails closed if an SDK caller has no context, an OAuth-looking context, or zero scopes", async () => {
    const calls: string[] = [];
    const handler = createMcpHandler(() => createMcpServer(
      handlers(calls), () => ({ toolset_hash: toolsetHash("private_token"), policy_epoch: 1 }), undefined, "private_token",
    ));
    const newRequest = () => new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-name": "system_status",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: uuidv7(), method: "tools/call",
        params: { name: "system_status", arguments: {}, _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "scope-context-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        } },
      }),
    });
    try {
      const missing = await handler.fetch(newRequest());
      expect(missing.status).toBe(200);
      expect(await missing.text()).toContain("SCOPE_DENIED");
      const spoofed = await handler.fetch(newRequest(), {
        authInfo: { token: "not-a-credential", clientId: "oauth-looking-id", scopes: ["hostspan.read"] },
      });
      expect(await spoofed.text()).toContain("SCOPE_DENIED");
      const emptyScopes = await handler.fetch(newRequest(), {
        authInfo: { token: "not-a-credential", clientId: "private_token:pt_fixture", scopes: [] },
      });
      expect(await emptyScopes.text()).toContain("SCOPE_DENIED");
      expect(calls).toEqual([]);
    } finally {
      await handler.close();
    }
  });
});

describe("private token CLI credential delivery", () => {
  it("writes once to a mode-0600 file and never needs the raw token on stdout", async () => {
    const { root, configPath, config } = fixture();
    const firstFile = join(root, "client-a.credential");
    expect(await main(["access", "token", "create", "--name", "fixture",
      "--scopes", "hostspan.read", "--output", firstFile, "--config", configPath])).toBe(0);
    const first = readFileSync(firstFile, "utf8").trim();
    if (process.platform !== "win32") expect(statSync(firstFile).mode & 0o777).toBe(0o600);
    const store = new PrivateTokenStore(config.server.data_dir);
    const tokenId = store.list()[0]?.token_id;
    expect(tokenId).toBeDefined();
    expect(store.verifyAuthorizationHeader(`Bearer ${first}`)).toBeDefined();
    store.close();
    const nextFile = join(root, "client-b.credential");
    expect(await main(["access", "token", "rotate", tokenId ?? "", "--output", nextFile, "--config", configPath])).toBe(0);
    const second = readFileSync(nextFile, "utf8").trim();
    const check = new PrivateTokenStore(config.server.data_dir);
    try {
      expect(check.verifyAuthorizationHeader(`Bearer ${first}`)).toBeUndefined();
      expect(check.verifyAuthorizationHeader(`Bearer ${second}`)).toBeDefined();
    } finally { check.close(); }
    expect(await main(["access", "token", "revoke", tokenId ?? "", "--config", configPath])).toBe(0);
    await expect(main(["access", "token", "create", "--name", "duplicate", "--scopes", "hostspan.read",
      "--output", firstFile, "--config", configPath])).rejects.toThrow();
  });
});

describe("private token MCP client interoperability", () => {
  it("serves 2025 and 2026 Streamable HTTP clients with static bearer, scope isolation, revocation, and PNG content", async () => {
    const { configPath } = fixture();
    const runtime = createRuntime(configPath);
    const store = runtime.privateTokens;
    if (!store) throw new Error("private token runtime is absent");
    const calls: string[] = [];
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+DkcoAAAAASUVORK5CYII=";
    const fakeHandlers = handlers(calls);
    fakeHandlers.computer = () => {
      calls.push("computer");
      return { message: "fixture image", image: png, mime_type: "image/png" };
    };
    const app = createHostSpanHttpServer({
      listen_host: "127.0.0.1",
      listen_port: 0,
      authenticationMode: "private_token",
      privateTokens: store,
      handlers: fakeHandlers,
      responseContext: () => ({ toolset_hash: toolsetHash("private_token"), policy_epoch: 12 }),
      status: { health: () => ({}), readiness: () => ({ ready: true }) },
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const endpoint = new URL("/mcp", address);
      const newClient = (era: "legacy" | "modern", credential: string) => {
        const client = new Client(
          { name: "hostspan-private-token-sdk-fixture", version: "1.0.0" },
          { versionNegotiation: { mode: era === "modern" ? "auto" : "legacy" } },
        );
        const transport = new StreamableHTTPClientTransport(endpoint, {
          authProvider: { token: async () => credential },
        });
        return { client, transport };
      };

      for (const era of ["legacy", "modern"] as const) {
        let readCredential = "";
        const readToken = store.issue(`sdk-read-${era}`, ["hostspan.read"], (secret) => { readCredential = secret; });
        let desktopCredential = "";
        const desktopToken = store.issue(`sdk-desktop-${era}`, ["hostspan.computer"], (secret) => { desktopCredential = secret; });
        const invalid = newClient(era, `hsp_${"x".repeat(43)}`);
        const read = newClient(era, readCredential);
        const desktop = newClient(era, desktopCredential);
        try {
          const beforeInvalid = calls.length;
          await expect(invalid.client.connect(invalid.transport)).rejects.toThrow();
          expect(calls).toHaveLength(beforeInvalid);

          await read.client.connect(read.transport);
          expect(read.client.getProtocolEra()).toBe(era);
          const listing = await read.client.listTools();
          expect(listing.tools.find((tool) => tool.name === "computer")).toMatchObject({
            _meta: { securitySchemes: [{ type: "http", scheme: "bearer" }] },
          });
          const status = await read.client.callTool({ name: "system_status", arguments: {} });
          expect(status.isError).not.toBe(true);
          expect(status.structuredContent).toMatchObject({
            authorization: { mode: "private_token", granted_scopes: ["hostspan.read"] },
          });
          const beforeDenied = calls.length;
          const denied = await read.client.callTool({ name: "computer", arguments: { action: "open" } });
          expect(denied.isError).toBe(true);
          expect(JSON.stringify(denied.structuredContent)).toContain("SCOPE_DENIED");
          expect(calls).toHaveLength(beforeDenied);

          await desktop.client.connect(desktop.transport);
          expect(desktop.client.getProtocolEra()).toBe(era);
          const image = await desktop.client.callTool({ name: "computer", arguments: { action: "open" } });
          expect(image.isError).not.toBe(true);
          expect(image.content).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "image", mimeType: "image/png", data: png }),
          ]));
          expect(image.structuredContent).not.toHaveProperty("image");
          expect(calls).toHaveLength(beforeDenied + 1);

          expect(store.revoke(readToken.token_id)).toBe(true);
          expect(store.revoke(desktopToken.token_id)).toBe(true);
          await expect(read.client.listTools()).rejects.toThrow();
          await expect(desktop.client.listTools()).rejects.toThrow();
        } finally {
          await Promise.allSettled([invalid.client.close(), read.client.close(), desktop.client.close()]);
        }
      }
    } finally {
      await app.close();
      await runtime.close();
    }
  });
});
