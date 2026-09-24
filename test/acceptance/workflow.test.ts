import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, runtimeReadiness } from "../../src/runtime/create-runtime.js";
import { runDoctor } from "../../src/diagnostics/doctor.js";
import { runSmoke } from "../../src/cli/smoke.js";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { TOOL_NAMES, TOOLSET_HASH } from "../../src/mcp/registry.js";
import { createHostSpanHttpServer } from "../../src/mcp/server.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hostspan-acceptance-"));
  roots.push(root);
  const targetRoot = join(root, "repo");
  const dataDir = join(root, "state");
  const configPath = join(root, "config.yaml");
  mkdirSync(targetRoot, { recursive: true });
  writeFileSync(join(targetRoot, "fixture.txt"), "alpha\nbeta\n", { mode: 0o600 });
  const config: HostSpanConfig = {
    schema_version: 1,
    policy_epoch: 7,
    server: { listen_host: "127.0.0.1", listen_port: 39393, data_dir: dataDir },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: 64 * 1024 * 1024,
    },
    targets: {
      local: {
        label: "Acceptance target",
        provider: "local",
        root: targetRoot,
        capabilities: ["read", "write", "exec"],
        exec_profile: "native-test",
        deny_globs: ["**/.env*", "**/*.pem", "**/*.key"],
        ignore_globs: ["**/node_modules/**", "**/dist/**"],
      },
    },
    exec_profiles: {
      "native-test": {
        mode: "native",
        default_deadline_ms: 30_000,
        max_deadline_ms: 60_000,
        default_output_bytes: 1024 * 1024,
        max_output_bytes: 8 * 1024 * 1024,
        max_concurrent_processes: 4,
      },
    },
  };
  writeConfigAtomic(configPath, config);
  return { root, targetRoot, configPath };
}

describe("HostSpan core acceptance", () => {
  it("serves the 2026-07-28 per-request HTTP protocol with the fixed toolset", async () => {
    const { configPath } = fixture();
    const runtime = createRuntime(configPath);
    const app = createHostSpanHttpServer({
      listen_host: "127.0.0.1",
      listen_port: 39393,
      handlers: runtime.handlers,
      responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: runtime.config.policy_epoch }),
      status: {
        health: () => ({ server_version: "test" }),
        readiness: () => ({ ready: true, degraded: false }),
      },
    });
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "hostspan-acceptance", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const post = async (address: string, id: string, method: string) => {
      const response = await fetch(`${address}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-method": method,
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { _meta: meta } }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const discover = await post(address, "discover-1", "server/discover");
      expect(discover.result).toMatchObject({
        supportedVersions: ["2026-07-28"],
        resultType: "complete",
      });
      const listed = await post(address, "tools-1", "tools/list");
      const result = listed.result as { tools?: Array<{ name?: string }> } | undefined;
      expect(result?.tools?.map((tool) => tool.name)).toEqual(TOOL_NAMES);
      expect(result?.tools).toHaveLength(10);
    } finally {
      await app.close();
      await runtime.close();
    }
  });

  it("serves concurrent stateless MCP clients without cross-request state", async () => {
    const { configPath } = fixture();
    const runtime = createRuntime(configPath);
    const app = createHostSpanHttpServer({
      listen_host: "127.0.0.1",
      listen_port: 39393,
      max_inflight_mcp_requests: 64,
      handlers: runtime.handlers,
      responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: runtime.config.policy_epoch }),
      status: {
        health: () => ({ server_version: "test" }),
        readiness: () => ({ ready: true, degraded: false }),
      },
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const responses = await Promise.all(
        Array.from({ length: 24 }, async (_, index) => {
          const meta = {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: `parallel-client-${index}`, version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          };
          const response = await fetch(`${address}/mcp`, {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              "mcp-method": "tools/call",
              "mcp-name": "system_status",
              "mcp-protocol-version": "2026-07-28",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: `parallel-${index}`,
              method: "tools/call",
              params: { name: "system_status", arguments: {}, _meta: meta },
            }),
          });
          expect(response.status).toBe(200);
          return (await response.json()) as {
            result?: { structuredContent?: { request_id?: string; toolset_hash?: string; policy_epoch?: number } };
          };
        }),
      );

      const requestIds = responses.map((response) => response.result?.structuredContent?.request_id);
      expect(requestIds.every((requestId) => typeof requestId === "string")).toBe(true);
      expect(new Set(requestIds).size).toBe(24);
      for (const response of responses) {
        expect(response.result?.structuredContent).toMatchObject({
          toolset_hash: TOOLSET_HASH,
          policy_epoch: runtime.config.policy_epoch,
        });
      }

      const requestIdSet = new Set(requestIds);
      const events = runtime.audit.recent(200).filter((event) => requestIdSet.has(String(event.request_id)));
      expect(events.filter((event) => event.event_type === "request.accepted")).toHaveLength(24);
      expect(events.filter((event) => event.event_type === "response.returned")).toHaveLength(24);
    } finally {
      await app.close();
      await runtime.close();
    }
  });

  it("passes doctor and the full local smoke workflow", async () => {
    const { configPath } = fixture();
    const doctor = await runDoctor(configPath);
    expect(doctor.ok, JSON.stringify(doctor.checks)).toBe(true);
    const runtime = createRuntime(configPath);
    try {
      const smoke = await runSmoke(runtime, "local");
      expect(smoke.ok, JSON.stringify(smoke.steps)).toBe(true);
      expect(smoke.steps.filter((step) => step.status === "fail")).toEqual([]);
    } finally {
      await runtime.close();
    }
  }, 15_000);

  it("fails readiness closed when the durable database backend is unavailable", async () => {
    const { configPath } = fixture();
    const runtime = createRuntime(configPath);
    try {
      runtime.db.close();
      expect(runtimeReadiness(runtime)).toMatchObject({
        ready: false,
        backends: { database: false, process: true },
      });
    } finally {
      await runtime.close();
    }
  });

});
