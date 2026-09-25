import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { PolicyGlobSchema, type HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { daemonStatus, requestDaemonShutdown, startDaemonControlServer } from "../../src/daemon/control.js";
import { main } from "../../src/cli/index.js";
import { createRuntime } from "../../src/runtime/create-runtime.js";
import { HostSpanLogger } from "../../src/observability/logger.js";
import { buildSupportExport } from "../../src/observability/support-export.js";
import { inspectWindowsAcl, protectWindowsFile, protectWindowsTree } from "../../src/security/windows-acl.js";
import { openReadOnlyDatabase } from "../../src/state/database.js";

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
  it("preserves the active control owner when another server attempts to start", async () => {
    const { root, configPath } = fixture();
    let shutdown = false;
    const control = await startDaemonControlServer(configPath, () => { shutdown = true; });
    try {
      await expect(startDaemonControlServer(configPath, () => {})).rejects.toThrow();
      expect(await requestDaemonShutdown(configPath)).toEqual({ ok: true, pid: process.pid });
      await new Promise((resolve) => setImmediate(resolve));
      expect(shutdown).toBe(true);
      await control.close();
      const replacement = await startDaemonControlServer(configPath, () => {});
      try {
        await control.close();
        expect(await requestDaemonShutdown(configPath)).toEqual({ ok: true, pid: process.pid });
      } finally {
        await replacement.close();
      }
      const pidPath = join(root, "state", "hostspan.pid");
      writeFileSync(pidPath, "2147483647\n");
      expect(daemonStatus(configPath).running).toBe(false);
      expect(readFileSync(pidPath, "utf8")).toBe("2147483647\n");
    } finally {
      await control.close();
    }
  });

  it("keeps policy glob syntax portable across HostSpan and ripgrep", () => {
    for (const glob of ["**/.env*", "**/node_modules/**", "src/*.ts", "file?.json"]) {
      expect(PolicyGlobSchema.safeParse(glob).success).toBe(true);
    }
    for (const glob of ["!secret/**", "src/[ab].ts", "src/{a,b}.ts", "src\\secret\\**", "bad\nname"]) {
      expect(PolicyGlobSchema.safeParse(glob).success).toBe(false);
    }
  });

  it.runIf(process.platform === "win32")("applies private Windows ACLs to config and durable state", async () => {
    const { configPath } = fixture();
    expect(inspectWindowsAcl(configPath)).toMatchObject({
      private: true,
      unexpected_allow_sids: [],
      missing_full_control_sids: [],
      deny_sids: [],
      inherited_rule_count: 0,
    });
    const runtime = createRuntime(configPath);
    try {
      expect(inspectWindowsAcl(runtime.config.server.data_dir)).toMatchObject({
        private: true,
        unexpected_allow_sids: [],
        missing_full_control_sids: [],
        deny_sids: [],
        inherited_rule_count: 0,
      });
    } finally {
      await runtime.close();
    }
  });

  it.runIf(process.platform === "win32")("removes pre-existing explicit Windows grants while hardening owned files", () => {
    const { configPath } = fixture();
    const grant = spawnSync("icacls.exe", [configPath, "/grant", "*S-1-1-0:R", "/Q"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    expect(grant.status, grant.stderr || grant.stdout).toBe(0);
    expect(inspectWindowsAcl(configPath).private).toBe(false);
    protectWindowsFile(configPath);
    expect(inspectWindowsAcl(configPath)).toMatchObject({
      private: true,
      unexpected_allow_sids: [],
      missing_full_control_sids: [],
      deny_sids: [],
      inherited_rule_count: 0,
    });
  });

  it.runIf(process.platform === "win32")("removes stale explicit grants from existing durable-state descendants", async () => {
    const { root, configPath } = fixture();
    const runtime = createRuntime(configPath);
    const statePath = join(runtime.config.server.data_dir, "state.db");
    await runtime.close();

    const grant = spawnSync("icacls.exe", [statePath, "/grant", "*S-1-1-0:R", "/Q"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    expect(grant.status, grant.stderr || grant.stdout).toBe(0);
    expect(inspectWindowsAcl(statePath).private).toBe(false);

    protectWindowsTree(join(root, "state"));
    expect(inspectWindowsAcl(statePath)).toMatchObject({
      private: true,
      unexpected_allow_sids: [],
      missing_full_control_sids: [],
      deny_sids: [],
      inherited_rule_count: 0,
    });
  });

  it("applies recursive deny globs to both root-level and nested secret paths", async () => {
    const { root, configPath } = fixture();
    const targetRoot = join(root, "target");
    mkdirSync(join(targetRoot, "nested"), { recursive: true });
    writeFileSync(join(targetRoot, ".env"), "ROOT_SECRET=1\n");
    writeFileSync(join(targetRoot, "nested", ".env.local"), "NESTED_SECRET=1\n");
    const runtime = createRuntime(configPath);
    try {
      for (const path of [".env", "nested/.env.local"]) {
        await expect(
          runtime.handlers.file_read(
            {
              target_id: "local",
              path,
              start_line: 1,
              end_line: 20,
              max_bytes: 4096,
              include_sha256: false,
            },
            `req_denied_${path}`,
          ),
        ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
      }
    } finally {
      await runtime.close();
    }
  });

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
      await runtime.close();
    }
  });

  it("redacts secret canaries from JSONL logs and support exports", async () => {
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
      const exported = JSON.stringify(buildSupportExport(runtime, "test-toolset-hash"));
      expect(exported).not.toContain(canary);
      expect(exported).not.toContain(runtime.targets.get("local").root_real);
      expect(exported).toContain("native_execution");
      expect(exported).toContain("sandboxed");
    } finally {
      await runtime.close();
    }
  });

  it("bounds JSONL files with deterministic size rotation", () => {
    const { root } = fixture();
    const dataDir = join(root, "rotation-state");
    const logger = new HostSpanLogger(dataDir, { maxFileBytes: 300, maxArchives: 2 });
    for (let index = 0; index < 20; index += 1) logger.info("rotation.test", { index, payload: "x".repeat(80) });
    const logDir = join(dataDir, "logs");
    expect(existsSync(join(logDir, "hostspan.jsonl"))).toBe(true);
    expect(existsSync(join(logDir, "hostspan.jsonl.1"))).toBe(true);
    expect(existsSync(join(logDir, "hostspan.jsonl.2"))).toBe(true);
    expect(existsSync(join(logDir, "hostspan.jsonl.3"))).toBe(false);
  });

  it("keeps support-export read-only with respect to durable process recovery state", async () => {
    const { root, configPath } = fixture();
    const runtime = createRuntime(configPath);
    const key = uuidv7();
    const args = { idempotency_key: key, target_id: "local", argv: ["node"], cwd: "." };
    runtime.operations.resolve(key, "process_start", args, "local");
    runtime.processes.create({
      process_id: "proc_support_readonly",
      idempotency_key: key,
      target_id: "local",
      argv_digest: "sha256:test",
      cwd_relative: ".",
    });
    runtime.processes.markRunning("proc_support_readonly", 999_999_991, 999_999_991);
    runtime.operations.setState(key, "running", { process_id: "proc_support_readonly" });
    const statePath = join(runtime.config.server.data_dir, "state.db");
    await runtime.close();

    const output = join(root, "support.json");
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await expect(main(["support-export", output, "--config", configPath])).resolves.toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }

    const readonly = openReadOnlyDatabase(statePath);
    try {
      expect(
        (readonly.prepare("SELECT state FROM processes WHERE process_id=?").get("proc_support_readonly") as { state: string }).state,
      ).toBe("running");
    } finally {
      readonly.close();
    }
  });

  it.each([
    { authority: "exec-only target", options: {} },
    { authority: "terminal-capable target", options: { terminal: true } },
  ])("allows native programs and env overrides with $authority", async ({ options }) => {
    const { configPath } = fixture(options);
    const runtime = createRuntime(configPath);
    try {
      let result = await runtime.handlers.process_start(
        {
          idempotency_key: uuidv7(),
          target_id: "local",
          argv: [process.execPath, "-e", "process.stdout.write(process.env.HOSTSPAN_TEST_ENV ?? '')"],
          cwd: ".",
          env: { HOSTSPAN_TEST_ENV: "unrestricted-exec-ok" },
          wait_ms: 1_000,
          deadline_ms: 5_000,
          max_output_bytes: 4096,
        },
        "req_unrestricted_exec",
      );
      let stdout = String(result.stdout ?? "");
      for (let attempt = 0; attempt < 12 && result.state === "running"; attempt += 1) {
        result = await runtime.handlers.process_poll(
          {
            process_id: String(result.process_id),
            stdout_cursor: Number(result.next_stdout_cursor ?? 0),
            stderr_cursor: Number(result.next_stderr_cursor ?? 0),
            wait_ms: 500,
            max_bytes: 4096,
          },
          `req_unrestricted_exec_poll_${attempt}`,
        );
        stdout += String(result.stdout ?? "");
      }
      expect({ ...result, stdout }).toMatchObject({
        state: "succeeded",
        stdout: "unrestricted-exec-ok",
        exit_code: 0,
        interactive: false,
      });
    } finally {
      await runtime.close();
    }
  });
});
