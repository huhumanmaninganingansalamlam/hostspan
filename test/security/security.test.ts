import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { createRuntime } from "../../src/cli/index.js";
import { HostSpanLogger } from "../../src/observability/logger.js";
import { buildSupportExport } from "../../src/observability/support-export.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { terminal?: boolean } = {}): { root: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), "hostspan-security-"));
  roots.push(root);
  const targetRoot = join(root, "target");
  const dataDir = join(root, "state");
  mkdirSync(targetRoot, { recursive: true });
  const configPath = join(targetRoot, "hostspan.yaml");
  const config: HostSpanConfig = {
    schema_version: 1,
    policy_epoch: 1,
    server: { listen_host: "127.0.0.1", listen_port: 39393, data_dir: dataDir },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: 1024 * 1024,
    },
    targets: {
      local: {
        label: "Local",
        provider: "local",
        root: targetRoot,
        capabilities: options.terminal ? ["read", "write", "exec", "terminal"] : ["read", "write", "exec"],
        exec_profile: "native",
        deny_globs: ["**/.env*", "**/*.pem", "**/*.key"],
        ignore_globs: [],
      },
    },
    exec_profiles: {
      native: {
        mode: "native",
        allowed_programs: ["node"],
        env_allowlist: ["CI"],
        default_deadline_ms: 30_000,
        max_deadline_ms: 60_000,
        default_output_bytes: 1024 * 1024,
        max_output_bytes: 8 * 1024 * 1024,
        max_concurrent_processes: 2,
      },
    },
  };
  writeConfigAtomic(configPath, config);
  return { root, configPath };
}

describe("security and operational boundaries", () => {
  it("blocks MCP self-mutation of the active HostSpan config", async () => {
    const { configPath } = fixture();
    const runtime = createRuntime(configPath);
    try {
      const before = readFileSync(configPath);
      const digest = createHash("sha256").update(before).digest("hex");
      const text = before.toString("utf8");
      const first = text.split("\n")[0] ?? "schema_version: 1";
      const patch = `@@ -1 +1 @@\n-${first}\n+${first} # modified\n`;
      await expect(
        runtime.handlers.file_patch(
          {
            idempotency_key: uuidv7(),
            target_id: "local",
            dry_run: false,
            files: [{ path: "hostspan.yaml", expected_sha256: digest, unified_diff: patch }],
            validators: [],
          },
          "req_self_edit",
        ),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
      expect(readFileSync(configPath)).toEqual(before);
    } finally {
      runtime.close();
    }
  });

  it("redacts secret canaries from JSONL logs and support exports", () => {
    const { root, configPath } = fixture();
    const canary = "HOSTSPAN_SECRET_CANARY_DO_NOT_LEAK_12345";
    const logger = new HostSpanLogger(join(root, "log-state"));
    logger.info("canary.test", { note: `prefix ${canary} suffix` });
    const log = readFileSync(join(root, "log-state", "logs", "hostspan.jsonl"), "utf8");
    expect(log).not.toContain(canary);
    expect(log).toContain("[REDACTED]");

    const runtime = createRuntime(configPath);
    try {
      runtime.audit.append({ request_id: "req_canary", event_type: "test", metadata: { note: canary } });
      const exported = JSON.stringify(buildSupportExport(runtime));
      expect(exported).not.toContain(canary);
      expect(exported).not.toContain(runtime.targets.get("local").root_real);
      expect(exported).toContain("native_execution");
      expect(exported).toContain("sandboxed");
    } finally {
      runtime.close();
    }
  });

  it("rejects environment variables outside the native exec profile allowlist", async () => {
    const { configPath } = fixture();
    const runtime = createRuntime(configPath);
    try {
      await expect(
        runtime.handlers.process_start(
          {
            idempotency_key: uuidv7(),
            target_id: "local",
            argv: ["node", "-e", "process.stdout.write('x')"],
            cwd: ".",
            env: { SECRET_TOKEN: "should-not-pass" },
            wait_ms: 100,
            deadline_ms: 5_000,
            max_output_bytes: 4096,
          },
          "req_env",
        ),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    } finally {
      runtime.close();
    }
  });

  it("keeps the program allowlist for exec-only targets", async () => {
    const { configPath } = fixture();
    const runtime = createRuntime(configPath);
    try {
      await expect(
        runtime.handlers.process_start(
          {
            idempotency_key: uuidv7(),
            target_id: "local",
            argv: ["bash", "-lc", "printf should-not-run"],
            cwd: ".",
            env: {},
            wait_ms: 100,
            deadline_ms: 5_000,
            max_output_bytes: 4096,
          },
          "req_exec_allowlist",
        ),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    } finally {
      runtime.close();
    }
  });

  it("does not make non-interactive exec weaker than terminal authority", async () => {
    const { configPath } = fixture({ terminal: true });
    const runtime = createRuntime(configPath);
    try {
      const result = await runtime.handlers.process_start(
        {
          idempotency_key: uuidv7(),
          target_id: "local",
          argv: [process.execPath, "-e", "process.stdout.write(process.env.HOSTSPAN_TEST_ENV ?? '')"],
          cwd: ".",
          env: { HOSTSPAN_TEST_ENV: "terminal-authority-ok" },
          wait_ms: 1_000,
          deadline_ms: 5_000,
          max_output_bytes: 4096,
        },
        "req_terminal_authority_exec",
      );
      expect(result).toMatchObject({ state: "succeeded", stdout: "terminal-authority-ok", exit_code: 0, interactive: false });
    } finally {
      runtime.close();
    }
  });
});
