# Troubleshooting

## `file_read` says `file_read_scan_limit`

`file_read` can seek to later line ranges without making `max_bytes` a scan limit, but one request will not scan more than 64 MiB just to locate a line. Use `file_search` to find the relevant symbol/text first, then request a narrower line range. This bound is intentional and prevents a single read from turning a very large/minified file into unbounded local I/O.

## App is not visible in ChatGPT

1. Run `hostspan doctor` and fix any `fail` checks.
2. Confirm HostSpan is listening on `127.0.0.1:39393` and `/readyz` is ready.
3. Confirm the Secure MCP Tunnel client is running and points to `http://127.0.0.1:39393/mcp`.
4. Recheck the tunnel endpoint configured in ChatGPT Developer Mode.
5. Use the app Refresh action after HostSpan/tunnel changes.

## Tools are missing or stale

Run:

```bash
hostspan print-toolset
```

HostSpan `hostspan-v3` must advertise exactly 11 tools. Target permissions never remove a tool from `tools/list`; a disallowed call returns `SCOPE_DENIED`. If ChatGPT still shows older cached tool metadata after upgrading, Refresh the app before debugging the server.

## Only read-only tools appear in one ChatGPT conversation

First compare `hostspan print-toolset` with the tool schemas actually injected into that conversation. If HostSpan advertises all 11 tools but `file_patch`, `process_start`, `process_write`, and `process_cancel` are absent, the filtering occurred in the ChatGPT app/action-permission or conversation tool-injection layer before a request reached HostSpan.

Check the app's enabled tools/action controls, use Refresh, explicitly select HostSpan in a new conversation, and delete/re-add the app only if the stale subset persists. Confirm the absence of a corresponding HostSpan transport/audit trace before classifying it as a server defect.

Do **not** mark side-effecting tools as `readOnlyHint=true`, omit their real risk semantics to evade client controls, or hide all operations behind a misleading generic tool. These changes cannot guarantee client injection and would make confirmation/audit behavior less trustworthy.

## A call does not reach HostSpan

Use:

```bash
hostspan logs --follow
```

Then reproduce once. A received transport request is logged before the handler, and an accepted tool call is recorded in the durable audit store. If neither exists, do not debug the HostSpan tool handler; inspect ChatGPT/tunnel behavior first.

## A workspace was added or removed but MCP still shows the old target list

This is expected until the daemon restarts. HostSpan snapshots target and policy configuration at startup so one request cannot observe a partially reloaded authorization policy. The tray writes the config atomically and offers an explicit restart; after restart, `target_list` and `system_status.policy_epoch` reflect the new configuration.

Before restarting, review the tray warning. Active ordinary native processes are stopped by daemon shutdown. Durable PTY interactive sessions remain alive in their session workers and reconnect to the same `process_id` after startup.

## `file_search` fails

HostSpan Alpha requires ripgrep. `hostspan doctor` reports whether `rg` is available. If missing, the server remains available in degraded mode but `file_search` returns `SEARCH_BACKEND_UNAVAILABLE`.

Broad/match-all searches are intentionally rejected or capped with `SEARCH_SCOPE_TOO_BROAD`.

## `STALE_CONTENT`

The file changed after it was read. Re-read the file with SHA-256, generate a new patch against the observed content, and submit with a new idempotency key. HostSpan does not overwrite stale content.

## `IDEMPOTENCY_CONFLICT`

The same key was previously submitted with different arguments. Do not reuse that key. The original operation remains authoritative for that key.

## Process is `unknown`

`unknown` means HostSpan cannot prove whether a crash-boundary side effect occurred. It is intentionally not retried automatically and is never reported as success. Inspect the target and external side effects, then submit a deliberate new operation with a new idempotency key only after deciding that replay is safe.

## Process is `orphaned`

`orphaned` means a process group remained alive across daemon recovery but HostSpan lost normal stream ownership. `process_cancel` can still attempt process-group cleanup. If cleanup cannot be verified, the state remains non-success.

PTY-backed `tty=true` processes are different: a session worker owns the PTY outside the HostSpan daemon, so a surviving worker is reconciled back to `running` after daemon restart instead of being marked orphaned. Use `hostspan terminal list` to inspect locally.

## `process_write` says the process is not interactive

`process_write` only accepts a process created with `process_start(..., tty=true)`. The target must include the explicit `terminal` capability and `hostspan doctor` must report the PTY runtime available.

For local observation or takeover:

```bash
hostspan terminal attach --process <process_id> --read-only
hostspan terminal attach --process <process_id>
```

## Cancelled process appears to remain

Collect a support bundle and check the stored `pgid`, terminal state, signal, and reason. Alpha sends SIGTERM to the process group, waits the requested grace period, then uses SIGKILL and checks group liveness. A group that cannot be proven gone is not marked cancelled.

## Unsupported HostSpan database schema

The current development line intentionally supports only the current durable state format. HostSpan does not guess or silently migrate an older `state.db`.

If Doctor/startup reports an unsupported schema, stop HostSpan and preserve that state directory before doing anything destructive. For a development machine where old state is disposable, point the new config at a fresh `server.data_dir` or archive the old HostSpan state directory and start clean. Do not overwrite the old database in place if you may need to inspect it later.

## Windows `config_acl` or `state_acl` fails

HostSpan's Windows config/secret files and durable state directory are expected to grant access only to the current Windows user and LocalSystem. Alpha.5 applies that DACL when it writes config/secrets and when the runtime or tray starts.

If Doctor still reports an unexpected principal, first start/restart the HostSpan runtime once so the owned paths can be hardened, then rerun Doctor. If the failure persists, the configured path may be on a filesystem/share that cannot enforce the required Windows ACL semantics; move HostSpan config/state to a user-owned NTFS location rather than weakening the check.

## `SERVER_BUSY` reports `process_output_spool`

HostSpan will not delete output for an active process just to admit a new process. If retained completed output cannot be evicted enough to bring `retention.max_total_spool_bytes` under its configured cap, new process output is rejected with retryable `SERVER_BUSY`.

Poll/read any output you still need, allow the configured output TTL to expire, or raise the local spool budget deliberately. Do not treat the quota error as a process failure that should be bypassed with unbounded logging.

## Server is alive but degraded

`/healthz` only means the daemon process is alive. `/readyz` means core config/database/tool registry are usable. `system_status.degraded=true` can indicate a non-core backend such as ripgrep is unavailable while other tools remain usable.

## Support bundle

```bash
hostspan support-export ./hostspan-support.json
```

The bundle includes versions, toolset hash, target aliases/capabilities, process lifecycle metadata, and recent audit events. It excludes target root paths, command argv content, and process stdout/stderr, and applies redaction. Review it before sharing.
