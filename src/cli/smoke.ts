import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { HostSpanConfig } from "../config/schema.js";
import { HostSpanError } from "../mcp/errors.js";
import { TOOL_NAMES, TOOLSET_HASH, type HostSpanToolHandlers } from "../mcp/registry.js";
import type { TargetRegistry } from "../targets/registry.js";

export interface SmokeContext {
  config: HostSpanConfig;
  targets: TargetRegistry;
  handlers: HostSpanToolHandlers;
}

export interface SmokeReport {
  ok: boolean;
  target_id: string;
  toolset_hash: string;
  steps: Array<{ name: string; status: "pass" | "fail" | "skip"; details?: string }>;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function runSmoke(context: SmokeContext, targetId: string): Promise<SmokeReport> {
  const steps: SmokeReport["steps"] = [];
  const target = context.targets.get(targetId);
  const record = async (name: string, run: () => Promise<void> | void): Promise<void> => {
    try {
      await run();
      steps.push({ name, status: "pass" });
    } catch (error) {
      steps.push({ name, status: "fail", details: error instanceof Error ? error.message : String(error) });
    }
  };

  await record("toolset", () => {
    if (TOOL_NAMES.length !== 11) throw new Error(`expected 11 tools, got ${TOOL_NAMES.length}`);
  });
  await record("target_list", async () => {
    const result = await context.handlers.target_list({}, "smoke_target_list");
    const targets = result.targets as Array<{ target_id: string }>;
    if (!targets.some((item) => item.target_id === targetId)) throw new Error("target_list did not return requested target");
  });

  const smokeDir = `.hostspan-smoke-${uuidv7().replaceAll("-", "")}`;
  const absoluteDir = join(target.root_real, smokeDir);
  const relativeFile = `${smokeDir}/probe.txt`;
  mkdirSync(absoluteDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(absoluteDir, "probe.txt"), "alpha\n", { mode: 0o600 });

  try {
    await record("file_list_read_search", async () => {
      const listed = await context.handlers.file_list(
        { target_id: targetId, path: smokeDir, depth: 1, max_entries: 20, include_hidden: true },
        "smoke_list",
      );
      if (!(listed.entries as Array<{ path: string }>).some((item) => item.path === relativeFile)) throw new Error("file_list missed probe file");
      const read = await context.handlers.file_read(
        { target_id: targetId, path: relativeFile, start_line: 1, end_line: 10, max_bytes: 4096, include_sha256: true },
        "smoke_read",
      );
      if (read.text !== "alpha\n" && read.text !== "alpha") throw new Error("file_read returned unexpected content");
      const searched = await context.handlers.file_search(
        {
          target_id: targetId,
          query: "alpha",
          paths: [smokeDir],
          context_before: 0,
          context_after: 0,
          max_matches: 10,
          max_bytes: 4096,
          deadline_ms: 5_000,
        },
        "smoke_search",
      );
      if (Number(searched.match_count) < 1) throw new Error("file_search found no match");
    });

    if (target.capabilities.includes("write")) {
      await record("file_patch_dry_run_apply_replay_conflict", async () => {
        const before = "alpha\n";
        const patch = "@@ -1 +1 @@\n-alpha\n+beta\n";
        const base = {
          target_id: targetId,
          files: [{ path: relativeFile, expected_sha256: hash(before), unified_diff: patch }],
          validators: ["git_diff_check" as const],
        };
        const dry = await context.handlers.file_patch({ idempotency_key: uuidv7(), dry_run: true, ...base }, "smoke_patch_dry");
        if (dry.dry_run !== true) throw new Error("dry-run patch did not report dry_run=true");
        const key = uuidv7();
        const applyInput = { idempotency_key: key, dry_run: false, ...base };
        const applied = await context.handlers.file_patch(applyInput, "smoke_patch_apply");
        if (!['verified', 'unverified'].includes(String(applied.state))) throw new Error(`unexpected patch state ${String(applied.state)}`);
        const replay = await context.handlers.file_patch(applyInput, "smoke_patch_replay");
        if (replay.state !== applied.state) throw new Error("duplicate patch key did not replay result");
        let conflict = false;
        try {
          await context.handlers.file_patch({ ...applyInput, dry_run: true }, "smoke_patch_conflict");
        } catch (error) {
          conflict = error instanceof HostSpanError && error.code === "IDEMPOTENCY_CONFLICT";
        }
        if (!conflict) throw new Error("same key with different patch arguments was not rejected");
      });
    } else {
      steps.push({ name: "file_patch", status: "skip", details: "target has no write capability" });
    }

    await record("path_escape", async () => {
      let rejected = false;
      try {
        await context.handlers.file_read(
          { target_id: targetId, path: "../outside", start_line: 1, end_line: 1, max_bytes: 128, include_sha256: false },
          "smoke_escape",
        );
      } catch (error) {
        rejected = error instanceof HostSpanError && error.code === "PATH_OUTSIDE_TARGET";
      }
      if (!rejected) throw new Error("path escape was not rejected");
    });

    if (target.capabilities.includes("git")) {
      await record("git_changes", async () => {
        await context.handlers.git_changes({ target_id: targetId, paths: [smokeDir], max_diff_bytes: 16_384, include_untracked: true }, "smoke_git");
      });
    }

    if (target.capabilities.includes("exec") && target.exec_profile) {
      const profile = context.config.exec_profiles[target.exec_profile];
      if (profile?.allowed_programs.includes("node")) {
        await record("short_process", async () => {
          let result = await context.handlers.process_start(
            {
              idempotency_key: uuidv7(),
              target_id: targetId,
              argv: ["node", "-e", "process.stdout.write('smoke')"],
              cwd: ".",
              env: {},
              wait_ms: 1_200,
              deadline_ms: 5_000,
              max_output_bytes: 64 * 1024,
            },
            "smoke_process_short",
          );
          let stdout = String(result.stdout ?? "");
          for (let attempt = 0; attempt < 8 && result.state === "running"; attempt += 1) {
            result = await context.handlers.process_poll(
              {
                process_id: String(result.process_id),
                stdout_cursor: Number(result.next_stdout_cursor ?? 0),
                stderr_cursor: Number(result.next_stderr_cursor ?? 0),
                wait_ms: 500,
                max_bytes: 64 * 1024,
              },
              `smoke_process_short_poll_${attempt}`,
            );
            stdout += String(result.stdout ?? "");
          }
          if (result.state !== "succeeded" || !stdout.includes("smoke")) {
            throw new Error(`short process failed: state=${String(result.state)} stdout=${JSON.stringify(stdout)}`);
          }
        });
        await record("long_process_cancel", async () => {
          const key = uuidv7();
          const input = {
            idempotency_key: key,
            target_id: targetId,
            argv: ["node", "-e", "setTimeout(()=>{},60000)"],
            cwd: ".",
            env: {},
            wait_ms: 25,
            deadline_ms: 60_000,
            max_output_bytes: 64 * 1024,
          };
          const first = await context.handlers.process_start(input, "smoke_process_long");
          const replay = await context.handlers.process_start(input, "smoke_process_replay");
          if (first.process_id !== replay.process_id) throw new Error("duplicate process key spawned a different process");
          const cancelled = await context.handlers.process_cancel(
            { idempotency_key: uuidv7(), process_id: String(first.process_id), grace_ms: 100 },
            "smoke_process_cancel",
          );
          if (cancelled.state !== "cancelled") throw new Error(`cancel ended in ${String(cancelled.state)}`);
        });
      } else {
        steps.push({ name: "process", status: "skip", details: "exec profile does not allow node; smoke harness uses node for deterministic fixtures" });
      }
    }
  } finally {
    rmSync(absoluteDir, { recursive: true, force: true });
  }

  return { ok: steps.every((step) => step.status !== "fail"), target_id: targetId, toolset_hash: TOOLSET_HASH, steps };
}
