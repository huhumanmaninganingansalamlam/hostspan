# HostSpan Alpha release notes

## Release contract

- Version: `0.2.0-alpha.3`
- Toolset: `hostspan-v1`
- MCP protocol target: `2026-07-28`
- Platform: Linux x64 (Ubuntu 24.04 LTS / WSL2)
- Client target: ChatGPT Web Developer Mode
- Transport: loopback HostSpan + OpenAI Secure MCP Tunnel; optional user-managed HTTPS reverse proxy/ingress

## Included

- immutable 10-tool MCP registry and stable toolset digest
- persistent explicit `target_id` routing
- atomic config writes and target registry
- canonical guarded list/read/search with ripgrep degradation reporting
- SHA-256 guarded dry-run/apply patch, validators, journal, and startup recovery
- deterministic bounded Git status/diff wrapper
- one durable native process supervisor for start/poll/cancel
- process-group deadline/cancel, byte cursors, UTF-8-safe output spool, idempotent submission
- SQLite WAL operation/process/transaction/audit state
- native exec policy, env/program/output/deadline/concurrency limits
- JSONL logging, redaction, short output retention, support export
- doctor/smoke/status/admin/service commands
- ChatGPT Refresh/tunnel/troubleshooting documentation
- ordinary reverse-proxy compatibility while HostSpan remains loopback-only and keeps Host validation enabled

## Explicitly excluded

PTY/stdin, SSH/multi-host execution, native Windows/macOS adapters, GUI/browser computer-use, LSP/CodeGraph, MCP aggregation, scheduler, desktop GUI, and an OS sandbox.

## Compatibility and migration

`hostspan-v1` tool names and input schemas are fixed for Alpha. A breaking tool-contract change requires a new toolset version and migration notes. Description/schema metadata changes alter `toolset_hash`; refresh the ChatGPT app after upgrading.

`0.2.0-alpha.3` does not change the `hostspan-v1` tool contract. It removes the provider-specific `hostspan expose` command introduced in alpha.2. HostSpan now stays transport-provider-neutral: OpenAI Secure MCP Tunnel remains the standard ChatGPT transport, and users who want another external path operate their own authenticated HTTPS reverse proxy/ingress in front of loopback `/mcp`.

Config and database both carry schema version 1. HostSpan fails closed if it encounters a newer database schema than the binary supports. Database initialization uses WAL; future migrations must back up the database before mutation.

## Release gates

Before publishing an Alpha build:

```bash
pnpm install --frozen-lockfile
pnpm check
hostspan doctor
hostspan smoke --target <approved-test-target>
```

Also verify local MCP Inspector compatibility where available. ChatGPT Web end-to-end validation may depend on external Developer Mode/Secure MCP Tunnel availability; a client-side block with no HostSpan request trace is a compatibility incident rather than a HostSpan release blocker.
