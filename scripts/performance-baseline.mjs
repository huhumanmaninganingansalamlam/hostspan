import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createRuntime } from "../dist/src/cli/index.js";
import { defaultConfigPath } from "../dist/src/config/paths.js";
import { loadConfig } from "../dist/src/config/loader.js";
import { writeConfigAtomic } from "../dist/src/config/writer.js";
import { TOOLSET_HASH } from "../dist/src/mcp/registry.js";
import { createHostSpanHttpServer } from "../dist/src/mcp/server.js";
import { buildPerformanceBaseline, summarizeWireSamples } from "../dist/src/observability/performance-baseline.js";
import { AuditRepo } from "../dist/src/state/audit-repo.js";
import { openReadOnlyDatabase } from "../dist/src/state/database.js";

const DEFAULT_AUDIT_EVENTS = 10_000;
const DEFAULT_SAMPLES = 10;

function usage() {
  return `Usage: node scripts/performance-baseline.mjs [options]

Options:
  --config <path>        HostSpan config used only to locate the durable audit DB.
  --audit-events <n>     Most recent audit events to summarize (default: ${DEFAULT_AUDIT_EVENTS}).
  --samples <n>          Samples per isolated MCP scenario (default: ${DEFAULT_SAMPLES}).
  --help                 Show this help.

The historical state database is opened read-only. Wire-size samples run only
against an isolated temporary loopback HostSpan fixture.`;
}

function positiveInt(raw, name, fallback, max) {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true };
    if (arg === "--config" || arg === "--audit-events" || arg === "--samples") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      values[arg.slice(2).replaceAll("-", "_")] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return {
    help: false,
    configPath: resolve(values.config ?? defaultConfigPath()),
    auditEvents: positiveInt(values.audit_events, "--audit-events", DEFAULT_AUDIT_EVENTS, 50_000),
    samples: positiveInt(values.samples, "--samples", DEFAULT_SAMPLES, 100),
  };
}

function readHistoricalBaseline(configPath, limit) {
  if (!existsSync(configPath)) return { available: false, reason: "config_missing" };
  const config = loadConfig(configPath);
  const statePath = join(config.server.data_dir, "state.db");
  if (!existsSync(statePath)) return { available: false, reason: "state_database_missing" };
  const db = openReadOnlyDatabase(statePath);
  try {
    return {
      available: true,
      summary: buildPerformanceBaseline(new AuditRepo(db), limit),
    };
  } finally {
    db.close();
  }
}

function fixtureConfig(dataDir, targetRoot) {
  return {
    schema_version: 1,
    policy_epoch: 1,
    server: { listen_host: "127.0.0.1", listen_port: 39393, data_dir: dataDir },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: 64 * 1024 * 1024,
    },
    targets: {
      local: {
        label: "Performance fixture",
        provider: "local",
        root: targetRoot,
        capabilities: ["read", "git"],
        deny_globs: [".git/objects/**"],
        ignore_globs: [],
      },
    },
    exec_profiles: {},
  };
}

function fixtureText() {
  const lines = [];
  for (let index = 1; index <= 1_500; index += 1) {
    const marker = index % 31 === 0 ? "needle" : "value";
    lines.push(`${String(index).padStart(4, "0")} ${marker} ${"x".repeat(48)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function runWireBaseline(samplesPerScenario) {
  const root = mkdtempSync(join(tmpdir(), "hostspan-perf-"));
  const targetRoot = join(root, "repo");
  const dataDir = join(root, "state");
  const configPath = join(root, "config.yaml");
  mkdirSync(join(targetRoot, "nested"), { recursive: true });
  writeFileSync(join(targetRoot, "fixture.txt"), fixtureText(), { mode: 0o600 });
  writeFileSync(join(targetRoot, "nested", "small.txt"), "small fixture\n", { mode: 0o600 });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: targetRoot });
  writeConfigAtomic(configPath, fixtureConfig(dataDir, targetRoot));

  const runtime = createRuntime(configPath);
  const app = createHostSpanHttpServer({
    listen_host: "127.0.0.1",
    listen_port: 39393,
    handlers: runtime.handlers,
    responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: runtime.config.policy_epoch }),
    status: {
      health: () => ({ server_version: "performance-baseline" }),
      readiness: () => ({ ready: true, degraded: false }),
    },
  });
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "hostspan-performance-baseline", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const scenarios = [
    { scenario: "system_status", tool: "system_status", arguments: {} },
    { scenario: "target_list", tool: "target_list", arguments: {} },
    {
      scenario: "file_list",
      tool: "file_list",
      arguments: { target_id: "local", path: ".", depth: 2, max_entries: 100 },
    },
    {
      scenario: "file_read_range",
      tool: "file_read",
      arguments: {
        target_id: "local",
        path: "fixture.txt",
        start_line: 1,
        end_line: 200,
        max_bytes: 64 * 1024,
        include_sha256: false,
      },
    },
    {
      scenario: "file_read_with_hash",
      tool: "file_read",
      arguments: {
        target_id: "local",
        path: "fixture.txt",
        start_line: 1,
        end_line: 200,
        max_bytes: 64 * 1024,
        include_sha256: true,
      },
    },
    {
      scenario: "file_search",
      tool: "file_search",
      arguments: {
        target_id: "local",
        query: "needle",
        paths: ["fixture.txt"],
        context_before: 1,
        context_after: 1,
        max_matches: 25,
        max_bytes: 64 * 1024,
        deadline_ms: 5_000,
      },
    },
    {
      scenario: "git_changes",
      tool: "git_changes",
      arguments: { target_id: "local", include_untracked: true, max_diff_bytes: 64 * 1024 },
    },
  ];
  let sequence = 0;
  let address;

  const call = async (definition) => {
    if (!address) throw new Error("isolated loopback server is not listening");
    sequence += 1;
    const started = performance.now();
    const response = await fetch(`${address}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-name": definition.tool,
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `perf-${String(sequence).padStart(6, "0")}`,
        method: "tools/call",
        params: { name: definition.tool, arguments: definition.arguments, _meta: meta },
      }),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const elapsed = Math.round((performance.now() - started) * 100) / 100;
    if (response.status !== 200) {
      throw new Error(`scenario ${definition.scenario} returned HTTP ${response.status}`);
    }
    const decoded = JSON.parse(body.toString("utf8"));
    if (decoded.error || decoded.result?.isError) {
      throw new Error(`scenario ${definition.scenario} returned an MCP error`);
    }
    return {
      scenario: definition.scenario,
      elapsed_ms: elapsed,
      response_bytes: body.byteLength,
    };
  };

  try {
    address = await app.listen({ host: "127.0.0.1", port: 0 });
    for (const definition of scenarios) await call(definition);
    const samples = [];
    for (let round = 0; round < samplesPerScenario; round += 1) {
      for (const definition of scenarios) samples.push(await call(definition));
    }
    return {
      samples_per_scenario: samplesPerScenario,
      scenarios: scenarios.map((item) => item.scenario),
      fixture: {
        isolated: true,
        loopback_only: true,
        read_only_tool_calls: true,
        file_lines: 1_500,
      },
      summary: summarizeWireSamples(samples),
    };
  } finally {
    await app.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const audit = readHistoricalBaseline(options.configPath, options.auditEvents);
  const wire = await runWireBaseline(options.samples);
  process.stdout.write(`${JSON.stringify({ generated_at: new Date().toISOString(), audit, wire }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
