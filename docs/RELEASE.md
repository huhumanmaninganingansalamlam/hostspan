# HostSpan Alpha release notes

## Release contract

- Version: `0.2.0-alpha.14`
- Toolset: `hostspan-v2`
- MCP protocol target: `2026-07-28`
- Platform: Linux x64 (Ubuntu 24.04 LTS / WSL2)
- Client target: ChatGPT Web Developer Mode
- Transport: loopback HostSpan + OpenAI Secure MCP Tunnel; optional user-managed HTTPS reverse proxy/ingress

## Included

- immutable 11-tool MCP registry and stable toolset digest
- persistent explicit `target_id` routing
- atomic config writes and target registry
- canonical guarded list/read/search with ripgrep degradation reporting
- SHA-256 guarded dry-run/apply patch, validators, journal, and startup recovery
- deterministic bounded Git status/diff wrapper
- one durable process lifecycle for native and tmux-backed interactive processes
- `process_write` for tmux-backed stdin/control keys/resize while retaining `process_poll` and `process_cancel`
- HostSpan-private tmux socket with local human read-only or read/write attach
- tmux session reconciliation across HostSpan daemon restart
- process-group deadline/cancel, byte cursors, UTF-8-safe output spool, idempotent submission
- SQLite WAL operation/process/transaction/audit state
- native exec policy, env/program/output/deadline/concurrency limits
- JSONL logging, redaction, short output retention, support export
- doctor/smoke/status/admin/service commands
- ChatGPT Refresh/tunnel/troubleshooting documentation
- configurable loopback/specific-IP/wildcard bind with fail-closed Host allowlists for reverse-proxy/LAN/container deployments
- built-in OAuth authorization-code + PKCE S256 for all non-loopback serving
- RFC 9728 protected-resource metadata, authorization-server discovery, and public-client registration compatibility
- hashed durable OAuth codes/tokens, short access-token TTL, rotating refresh tokens, approval-secret rotation/revocation
- MCP-SDK-compatible OAuth issuer/endpoint/scope surface proven against ChatGPT Developer Mode
- bounded overload admission: 128 in-flight MCP requests by default, bounded ripgrep concurrency/queue, retryable `SERVER_BUSY`
- lightweight cached runtime backend probes; full SQLite integrity checks remain in `doctor`
- audit history bounded by age and `max_audit_events` (500,000 by default)
- detached `hostspan daemon start|stop|status` management
- optional Electron tray/dashboard for daemon start/stop/restart, Doctor health, active work, workspace add/remove, login autostart, recent calls, and tmux attach

## Explicitly excluded

Multi-host routing, native Windows/macOS process adapters, GUI/browser computer-use, LSP/CodeGraph, MCP aggregation, scheduler, and an OS sandbox. The small tray/dashboard is a local management surface, not computer-use automation.

## Compatibility and migration

`hostspan-v2` tool names and input schemas are fixed for this Alpha line. `v2` is intentionally a breaking tool-contract revision from `hostspan-v1`: `process_start` gains optional TTY fields and `process_write` is added. Description/schema metadata changes alter `toolset_hash`; refresh the ChatGPT app after upgrading.

`0.2.0-alpha.14` keeps the `hostspan-v2` 11-tool schema unchanged and polishes Add Workspace: Cancel is independent of form validation, all five capabilities default on, and target ID/label are optional with folder-derived defaults and collision-safe generated IDs. Alpha.13 completed the daily-use tray management surface. Remote non-loopback serving still fails closed without OAuth. Existing targets do not gain terminal authority automatically: add the explicit `terminal` capability before `tty=true` is accepted. Existing non-interactive `process_start`/`process_poll`/`process_cancel` semantics remain available.

Config schema remains version 1. The durable database schema is version 4 and adds process backend/session/deadline/output-cap metadata so tmux sessions can be reconciled after daemon restart. Database initialization uses WAL and backs up an existing database before migration.

## Release gates

Before publishing an Alpha build:

```bash
pnpm install --frozen-lockfile
pnpm check
hostspan doctor
hostspan smoke --target <approved-test-target>
```

Also verify local MCP Inspector compatibility where available. ChatGPT Web end-to-end validation may depend on external Developer Mode/Secure MCP Tunnel availability; a client-side block with no HostSpan request trace is a compatibility incident rather than a HostSpan release blocker.
