# Local operator workflows

This page owns day-to-day HostSpan commands and recovery semantics. [README](../README.md) is the quick start; [Architecture](ARCHITECTURE.md) explains ownership; [Security](SECURITY.md) defines authority; [ChatGPT](CHATGPT.md) owns remote tunnel/OAuth/proxy setup.

## Profile and targets

For the installed CLI (or prefix each command with `node dist/src/cli/index.js` when using a source build):

```bash
hostspan init
hostspan targets add \
  --id local-app --label "Main application" \
  --root /absolute/path/to/project \
  --capabilities read,write,exec,terminal \
  --exec-profile native-dev
hostspan policy validate
hostspan doctor
hostspan smoke --target local-app
```

The selected local admin profile is under the user's configuration directory by default. `--config /path/to/config.yaml` or `HOSTSPAN_CONFIG` selects another file. Workspace add/remove and policy mutations are local administrative actions, **not MCP tools**. Changes to targets, policy, and saved screen-access settings require a deliberate daemon restart. An `exec` capability does not silently grant interactive `terminal`.

Examples: [config](../examples/hostspan.example.yaml) and [policy](../examples/policy.example.yaml). Target `deny_globs` / `ignore_globs` use portable slash paths and `*`, `**`, `?`; unsupported shell-style escapes/globs are rejected. Native and PTY processes inherit the daemon's OS environment with caller `env` taking precedence. A headless service does not acquire the login desktop automatically.

## Serve, daemon and health

```bash
hostspan serve               # foreground/debug mode
hostspan daemon start
hostspan daemon status
hostspan daemon stop
hostspan status --verbose    # installed build receipt and selected profile
hostspan admin snapshot      # local operator visibility, not public HTTP
hostspan print-toolset
```

Default local addresses: MCP `http://127.0.0.1:39393/mcp`, health `/healthz`, readiness `/readyz`. Readiness checks the durable DB/platform; degraded search/terminal availability does not equate to a fully dead server. Never expose these endpoints broadly without the authentication rules in [Security](SECURITY.md) and [ChatGPT connection](CHATGPT.md).

`hostspan --version --verbose` reads the build identity embedded at packaging time, not the current Git checkout; a daemon already running another version needs its own `system_status` check. Use `hostspan logs --follow` and a *reviewed, redacted* `hostspan support-export ./hostspan-support.json` for support; raw secrets and process output must not enter public issue reports.

## File and search behavior

Every file call names a persistent `target_id` and a target-relative path. `file_read(start_byte=0)` returns a byte page and `next_byte`; continue with the first `sha256` as `expected_sha256`. If the file changed, `STALE_CONTENT` is intentional. For large late-line positions, `file_read` has a fixed scan ceiling; locate text first via `file_search` rather than unbounded reads. Search input is a regular expression, not a shell command or glob. Target deny/ignore policy applies to both discovery and reads.

`file_patch` supports SHA-guarded dry-run/staging, a durable journal and verified replacement. A failed validator or stale precondition must leave the old file unchanged. Use a **fresh UUIDv7** idempotency key for each new side effect; reuse it only for an identical retry.

## Native and PTY execution

`process_start` starts an approved native program. Use `tty=true` only when the target explicitly grants `terminal`; it creates a durable, HostSpan-owned interactive PTY session. `process_poll` reads output, `process_write` sends text/control keys or resizing, and `process_cancel` closes the process. A person may attach deliberately:

```bash
hostspan terminal attach --process ORIGINAL_PROCESS_ID --read-only
hostspan terminal attach --process ORIGINAL_PROCESS_ID
```

`wait_ms` bounds response waiting, **not process lifetime**. Omit `deadline_ms` for no implicit deadline; set it for an intentional timeout. `max_bytes` caps response payload, while `max_output_bytes` caps retained output without killing the command. Output caps and global spool/retention limits may evict history; inspect `output_expired`, dropped-byte counts and earliest available cursors. `exit_code_scope=spawned_command` belongs to the started wrapper; nested test result files must be inspected separately.

### Recover the original process after connection loss

Do not invent or reissue a new `process_start` after losing a response. Use the existing daemon/profile owner to find the original durable record:

```bash
hostspan process list --target TARGET --cwd project/relative/path \
  --active-only false --limit 100 --config /path/to/config.yaml
hostspan process poll --process ORIGINAL_PROCESS_ID \
  --stdout-cursor 0 --stderr-cursor 0 --wait-ms 1000 \
  --max-bytes 65536 --config /path/to/config.yaml
```

For subsequent calls use `next_stdout_cursor` and `next_stderr_cursor` from that same process's previous response. Cursors are **independent byte offsets**, not Unicode character positions. `has_more_output` means retained output remains to be consumed; it is not process completion. Keep `unknown` (unprovable outcome) distinct from `orphaned` (surviving process classified after failure). Never retype or rerun an input whose delivery is uncertain. A successful CLI poll exits 0 even if the **original** process failed; inspect its `state`, `exit_code`, and `signal`.

The CLI list/poll path uses the authenticated local daemon channel, does not create new process work, and does not silently reauthenticate to MCP. `process_list` limits visibility to the configured target and allowed cwd. Metadata alone does not prove that a process belongs to a specific chat task.

## Retention and overload

Default budgets (unless an existing profile explicitly overrides them) include: 128 inflight MCP requests; 8 concurrent searches plus 16 queued; one-second search queue timeout; 16 native processes/PTY sessions per target; completed output TTL up to 1,440 minutes; operation response compaction after 14 days; audit age 30 days with 500,000-event default cap; aggregate retained spool 1 GiB. These are limits, not promises of long-term output storage.

Source of truth: [config schema](../src/config/schema.ts) and [runtime retention](../src/runtime/retention-maintenance.ts). `SERVER_BUSY` is a real admission failure; do not weaken boundaries or treat it as completed work. `CURSOR_EXPIRED` means the requested byte position is no longer available; do not silently reset without surfacing loss.

## Optional desktop control and scope

```bash
hostspan computer status
hostspan computer enable --config /path/to/config.yaml
# Explicitly restart the selected daemon after saving configuration.
hostspan computer disable --config /path/to/config.yaml
```

Computer Use is OFF by default for new profiles. Explicit enable does not itself open a permission dialog. macOS requires Screen Recording and Accessibility; Windows requires the active unlocked console desktop; Linux needs the Wayland screen-sharing portal and user consent. Call `computer.open`, then `observe` and preserve the returned `session_id` and `observation_id`. The image bounds pointer coordinates, **not** keyboard focus or operating-system authority.

Desktop mutations are not automatically replayed after an uncertain delivery. A delivered input is not proof of visible application success: inspect the next image. If a capture fails, retry **observe**, not the input. Close the session to release OS sharing. See [Security](SECURITY.md), [Troubleshooting](TROUBLESHOOTING.md) and [Computer implementation](../src/computer/portal.ts).

## Distribution

Desktop builds, installer smoke, OS-specific helpers and signing status are documented only in [Distribution](DISTRIBUTION.md). `pnpm desktop:dir`/ `desktop:make` clean `out/`; preserve previous candidates before rebuilding. Release identity and historical qualification belong in [Release notes](RELEASE.md), not in this operating runbook.
