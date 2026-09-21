import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createRuntime, runtimeReadiness } from "../../src/cli/index.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { runSmoke } from "../../src/cli/smoke.js";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { TOOL_NAMES, TOOLSET_HASH } from "../../src/mcp/registry.js";
import { createHostSpanHttpServer } from "../../src/mcp/server.js";
import { FileReadInputSchema } from "../../src/mcp/schemas.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hostspan-alpha-"));
  roots.push(root);
  const targetRoot = join(root, "repo");
  const dataDir = join(root, "state");
  const configPath = join(root, "config.yaml");
  mkdirSync(targetRoot, { recursive: true });
  writeFileSync(join(targetRoot, "fixture.txt"), "alpha\nbeta\n", { mode: 0o600 });
  execFileSync("git", ["init", "-b", "main"], { cwd: targetRoot });
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
        capabilities: ["read", "write", "exec", "git"],
        exec_profile: "native-test",
        deny_globs: ["**/.env*", "**/*.pem", "**/*.key", ".git/objects/**"],
        ignore_globs: ["**/node_modules/**", "**/dist/**"],
      },
    },
    exec_profiles: {
      "native-test": {
        mode: "native",
        allowed_programs: ["node", "git"],
        env_allowlist: ["CI", "LANG"],
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

describe("HostSpan Alpha acceptance", () => {
  it("keeps the exact static 11-tool contract and rejects unknown input fields", () => {
    expect(TOOL_NAMES).toHaveLength(11);
    expect(new Set(TOOL_NAMES).size).toBe(11);
    expect(TOOLSET_HASH).toMatch(/^sha256:[0-9a-f]{64}$/);
    const parsed = FileReadInputSchema.safeParse({
      target_id: "local",
      path: "fixture.txt",
      start_line: 1,
      end_line: 1,
      max_bytes: 1024,
      include_sha256: true,
      unexpected: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects non-loopback Host headers while health/readiness remain explicit", async () => {
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
    try {
      const rejected = await app.inject({ method: "GET", url: "/healthz", headers: { host: "evil.example" } });
      // @modelcontextprotocol/fastify rejects the Host header before HostSpan's
      // fallback validation hook, so the transport-level response is 403.
      expect(rejected.statusCode).toBe(403);
      const health = await app.inject({ method: "GET", url: "/healthz", headers: { host: "127.0.0.1:39393" } });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ status: "ok", server_version: "test" });
      const ready = await app.inject({ method: "GET", url: "/readyz", headers: { host: "localhost:39393" } });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({ ready: true, degraded: false });
    } finally {
      await app.close();
      await runtime.close();
    }
  });

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
      expect(result?.tools).toHaveLength(11);
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

  it("runs a 10-turn workflow 50 times without toolset drift and records every handled call", async () => {
    const { configPath } = fixture();
    const runtime = createRuntime(configPath);
    const beforeHash = TOOLSET_HASH;
    const beforeText = "alpha\nbeta\n";
    const expected = createHash("sha256").update(beforeText).digest("hex");
    try {
      for (let iteration = 0; iteration < 50; iteration += 1) {
        const prefix = `soak_${iteration}`;
        await runtime.handlers.target_list({}, `${prefix}_1`);
        await runtime.handlers.file_list({ target_id: "local", path: ".", depth: 1, max_entries: 50, include_hidden: false }, `${prefix}_2`);
        await runtime.handlers.file_read(
          { target_id: "local", path: "fixture.txt", start_line: 1, end_line: 10, max_bytes: 4096, include_sha256: true },
          `${prefix}_3`,
        );
        await runtime.handlers.file_search(
          {
            target_id: "local",
            query: "alpha",
            paths: ["."],
            context_before: 0,
            context_after: 1,
            max_matches: 10,
            max_bytes: 8192,
            deadline_ms: 5_000,
          },
          `${prefix}_4`,
        );
        await runtime.handlers.git_changes({ target_id: "local", paths: ["fixture.txt"], max_diff_bytes: 8192, include_untracked: true }, `${prefix}_5`);
        await runtime.handlers.file_patch(
          {
            idempotency_key: uuidv7(),
            target_id: "local",
            dry_run: true,
            files: [
              {
                path: "fixture.txt",
                expected_sha256: expected,
                unified_diff: "@@ -1,2 +1,2 @@\n-alpha\n+alpha-soak\n beta\n",
              },
            ],
            validators: ["git_diff_check"],
          },
          `${prefix}_6`,
        );
        await runtime.handlers.file_read(
          { target_id: "local", path: "fixture.txt", start_line: 1, end_line: 1, max_bytes: 1024, include_sha256: false },
          `${prefix}_7`,
        );
        await runtime.handlers.file_list({ target_id: "local", path: ".", depth: 0, max_entries: 50, include_hidden: false }, `${prefix}_8`);
        await runtime.handlers.target_list({}, `${prefix}_9`);
        await runtime.handlers.system_status({}, `${prefix}_10`);
      }
      expect(TOOLSET_HASH).toBe(beforeHash);
      const events = runtime.audit.recent(2_000);
      const soakEvents = events.filter((event) => String(event.request_id).startsWith("soak_"));
      expect(soakEvents.filter((event) => event.event_type === "request.accepted")).toHaveLength(500);
      expect(soakEvents.filter((event) => event.event_type === "response.returned")).toHaveLength(500);
    } finally {
      await runtime.close();
    }
  }, process.platform === "win32" ? 120_000 : 30_000);
});
