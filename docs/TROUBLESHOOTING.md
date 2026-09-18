# Troubleshooting

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

HostSpan `hostspan-v2` must advertise exactly 11 tools. Target permissions never remove a tool from `tools/list`; a disallowed call returns `SCOPE_DENIED`. If ChatGPT still shows the old 10-tool `hostspan-v1` schema after upgrading, Refresh the app before debugging the server.

## A call does not reach HostSpan

Use:

```bash
hostspan logs --follow
```

Then reproduce once. A received transport request is logged before the handler, and an accepted tool call is recorded in the durable audit store. If neither exists, do not debug the HostSpan tool handler; inspect ChatGPT/tunnel behavior first.

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

tmux-backed `tty=true` processes are different: tmux owns the PTY outside the HostSpan daemon, so a surviving tmux session is reconciled back to `running` after daemon restart instead of being marked orphaned. Use `hostspan terminal list` to inspect locally.

## `process_write` says the process is not interactive

`process_write` only accepts a process created with `process_start(..., tty=true)`. The target must include the explicit `terminal` capability and `hostspan doctor` must report tmux available.

For local observation or takeover:

```bash
hostspan terminal attach --process <process_id> --read-only
hostspan terminal attach --process <process_id>
```

## Cancelled process appears to remain

Collect a support bundle and check the stored `pgid`, terminal state, signal, and reason. Alpha sends SIGTERM to the process group, waits the requested grace period, then uses SIGKILL and checks group liveness. A group that cannot be proven gone is not marked cancelled.

## Server is alive but degraded

`/healthz` only means the daemon process is alive. `/readyz` means core config/database/tool registry are usable. `system_status.degraded=true` can indicate a non-core backend such as ripgrep is unavailable while other tools remain usable.

## Support bundle

```bash
hostspan support-export ./hostspan-support.json
```

The bundle includes versions, toolset hash, target aliases/capabilities, process lifecycle metadata, and recent audit events. It excludes target root paths, command argv content, and process stdout/stderr, and applies redaction. Review it before sharing.
