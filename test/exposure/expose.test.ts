import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/cli/index.js";
import { startExposure, type ExposureSession } from "../../src/cli/expose.js";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { TOOL_NAMES } from "../../src/mcp/registry.js";

const roots: string[] = [];
const sessions: ExposureSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hostspan-expose-"));
  roots.push(root);
  const targetRoot = join(root, "repo");
  const dataDir = join(root, "state");
  const configPath = join(root, "config.yaml");
  mkdirSync(targetRoot, { recursive: true });
  const config: HostSpanConfig = {
    schema_version: 1,
    policy_epoch: 3,
    server: { listen_host: "127.0.0.1", listen_port: 39393, data_dir: dataDir },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: 64 * 1024 * 1024,
    },
    targets: {
      local: {
        label: "Exposure target",
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
  const fakeCloudflared = join(root, "cloudflared");
  writeFileSync(
    fakeCloudflared,
    "#!/bin/sh\nprintf '%s\\n' 'INF quick tunnel https://fixture.trycloudflare.com ready' >&2\nprintf '%s\\n' 'INF Registered tunnel connection protocol=quic' >&2\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
    { mode: 0o700 },
  );
  chmodSync(fakeCloudflared, 0o700);
  return { root, dataDir, configPath, fakeCloudflared };
}

function modernRequestBody(id: string, method: string) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "hostspan-exposure-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
}

describe("automatic external MCP exposure", () => {
  it("publishes only a random capability MCP path and does not log the capability", async () => {
    const { dataDir, configPath, fakeCloudflared } = fixture();
    const runtime = createRuntime(configPath);
    try {
      const session = await startExposure(runtime, { cloudflared: fakeCloudflared, timeout_ms: 2_000 });
      sessions.push(session);
      expect(session.public_mcp_url).toBe(`https://fixture.trycloudflare.com${session.capability_path}`);
      expect(session.capability_path).toMatch(/^\/mcp\/[A-Za-z0-9_-]{43}$/);

      expect((await fetch(`${session.local_origin}/mcp`)).status).toBe(404);
      expect((await fetch(`${session.local_origin}/healthz`)).status).toBe(404);
      expect((await fetch(`${session.local_origin}/readyz`)).status).toBe(404);

      const response = await fetch(`${session.local_origin}${session.capability_path}`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
        },
        body: modernRequestBody("tools-1", "tools/list"),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result?: { tools?: Array<{ name?: string }> } };
      expect(body.result?.tools?.map((tool) => tool.name)).toEqual(TOOL_NAMES);

      const logText = readFileSync(join(dataDir, "logs", "hostspan.jsonl"), "utf8");
      expect(logText).toContain('"url":"/mcp"');
      expect(logText).not.toContain(session.capability_path);
    } finally {
      await runtime.supervisor.shutdown();
      runtime.close();
    }
  });

  it("fails explicitly when the cloudflared helper is unavailable", async () => {
    const { configPath } = fixture();
    const runtime = createRuntime(configPath);
    try {
      await expect(startExposure(runtime, { cloudflared: "/definitely/missing/cloudflared", timeout_ms: 500 })).rejects.toThrow(
        /cloudflared was not found/,
      );
    } finally {
      await runtime.supervisor.shutdown();
      runtime.close();
    }
  });
});
