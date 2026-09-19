import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/cli/index.js";
import { HostSpanConfigSchema, type HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { TOOL_NAMES, TOOLSET_HASH } from "../../src/mcp/registry.js";
import { createHostSpanHttpServer, resolveAllowedHosts } from "../../src/mcp/server.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hostspan-proxy-"));
  roots.push(root);
  const targetRoot = join(root, "repo");
  const configPath = join(root, "config.yaml");
  mkdirSync(targetRoot, { recursive: true });
  writeFileSync(join(targetRoot, "fixture.txt"), "proxy\n", { mode: 0o600 });
  const config: HostSpanConfig = {
    schema_version: 1,
    policy_epoch: 3,
    server: { listen_host: "127.0.0.1", listen_port: 39393, data_dir: join(root, "state") },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: 16 * 1024 * 1024,
    },
    targets: {
      local: {
        label: "Proxy target",
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
  return { configPath };
}

async function listenProxy(upstream: URL): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((incoming, outgoing) => {
    if (incoming.url !== "/mcp") {
      outgoing.writeHead(404).end();
      return;
    }
    const headers = { ...incoming.headers, host: upstream.host };
    const proxied = httpRequest(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: "/mcp",
        method: incoming.method,
        headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    proxied.on("error", (error) => {
      outgoing.writeHead(502, { "content-type": "text/plain" }).end(error.message);
    });
    incoming.pipe(proxied);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

describe("user-managed reverse proxy", () => {
  it("requires an explicit Host allowlist for wildcard binds", () => {
    const base = {
      schema_version: 1 as const,
      policy_epoch: 1,
      retention: {
        completed_process_output_ttl_minutes: 60,
        operation_result_days: 14,
        audit_days: 30,
        max_total_spool_bytes: 1024,
      },
      targets: {},
      exec_profiles: {},
    };
    expect(
      HostSpanConfigSchema.safeParse({
        ...base,
        server: { listen_host: "0.0.0.0", listen_port: 39393, data_dir: "/tmp/hostspan" },
      }).success,
    ).toBe(false);
    expect(
      HostSpanConfigSchema.safeParse({
        ...base,
        server: {
          listen_host: "0.0.0.0",
          listen_port: 39393,
          allowed_hosts: ["mcp.example.com", "192.168.10.20"],
          data_dir: "/tmp/hostspan",
        },
      }).success,
    ).toBe(true);
    expect(resolveAllowedHosts("192.168.10.20")).toEqual(["192.168.10.20"]);
    expect(() => resolveAllowedHosts("::")).toThrow(/allowed_hosts/);
  });

  it("requires OAuth before serving on non-loopback interfaces", () => {
    const { configPath } = fixture();
    const runtime = createRuntime(configPath);
    try {
      expect(() =>
        createHostSpanHttpServer({
          listen_host: "0.0.0.0",
          listen_port: 0,
          allowed_hosts: ["mcp.example.com"],
          handlers: runtime.handlers,
          responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: runtime.config.policy_epoch }),
          status: {
            health: () => ({ server_version: "test" }),
            readiness: () => ({ ready: true, degraded: false }),
          },
        }),
      ).toThrow(/requires OAuth/);
    } finally {
      runtime.close();
    }
  });

  it("passes MCP 2026-07-28 stateless calls when the proxy rewrites the upstream Host", async () => {
    const { configPath } = fixture();
    const runtime = createRuntime(configPath);
    const app = createHostSpanHttpServer({
      listen_host: "127.0.0.1",
      listen_port: 0,
      handlers: runtime.handlers,
      responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: runtime.config.policy_epoch }),
      status: {
        health: () => ({ server_version: "test" }),
        readiness: () => ({ ready: true, degraded: false }),
      },
    });
    let proxy: Awaited<ReturnType<typeof listenProxy>> | undefined;
    try {
      const upstream = new URL(await app.listen({ host: "127.0.0.1", port: 0 }));
      proxy = await listenProxy(upstream);
      const meta = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "reverse-proxy-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      };
      const post = async (body: Record<string, unknown>, method: string, name?: string) => {
        const response = await fetch(`${proxy?.origin}/mcp`, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-method": method,
            "mcp-protocol-version": "2026-07-28",
            ...(name ? { "mcp-name": name } : {}),
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as Record<string, unknown>;
      };
      const listed = await post(
        {
          jsonrpc: "2.0",
          id: "proxy-tools",
          method: "tools/list",
          params: {
            _meta: meta,
          },
        },
        "tools/list",
      );
      const listResult = listed.result as { tools?: Array<{ name?: string }> } | undefined;
      expect(listResult?.tools?.map((tool) => tool.name)).toEqual(TOOL_NAMES);

      const status = await post(
        {
          jsonrpc: "2.0",
          id: "proxy-status",
          method: "tools/call",
          params: { name: "system_status", arguments: {}, _meta: meta },
        },
        "tools/call",
        "system_status",
      );
      const statusResult = status.result as { structuredContent?: Record<string, unknown> } | undefined;
      expect(statusResult?.structuredContent).toMatchObject({
        toolset_hash: TOOLSET_HASH,
        toolset_version: "hostspan-v3",
      });

      const hiddenDiagnostics = await fetch(`${proxy.origin}/healthz`);
      expect(hiddenDiagnostics.status).toBe(404);
    } finally {
      await proxy?.close();
      await app.close();
      runtime.close();
    }
  });

  it("keeps direct non-loopback Host access rejected", async () => {
    const { configPath } = fixture();
    const runtime = createRuntime(configPath);
    const app = createHostSpanHttpServer({
      listen_host: "127.0.0.1",
      listen_port: 0,
      handlers: runtime.handlers,
      responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: runtime.config.policy_epoch }),
      status: {
        health: () => ({ server_version: "test" }),
        readiness: () => ({ ready: true, degraded: false }),
      },
    });
    try {
      const rejected = await app.inject({ method: "GET", url: "/healthz", headers: { host: "mcp.example.com" } });
      expect([403, 421]).toContain(rejected.statusCode);
    } finally {
      await app.close();
      runtime.close();
    }
  });
});
