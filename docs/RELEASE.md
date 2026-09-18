# HostSpan Alpha release notes

## Release contract

- Version: `0.2.0-alpha.10`
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
- configurable loopback/specific-IP/wildcard bind with fail-closed Host allowlists for reverse-proxy/LAN/container deployments
- built-in OAuth authorization-code + PKCE S256 for all non-loopback serving
- RFC 9728 protected-resource metadata, authorization-server discovery, and public-client registration compatibility
- hashed durable OAuth codes/tokens, short access-token TTL, rotating refresh tokens, approval-secret rotation/revocation
- MCP-SDK-compatible OAuth issuer/endpoint/scope surface proven against ChatGPT Developer Mode
- bounded overload admission: 128 in-flight MCP requests by default, bounded ripgrep concurrency/queue, retryable `SERVER_BUSY`
- lightweight cached runtime backend probes; full SQLite integrity checks remain in `doctor`
- audit history bounded by age and `max_audit_events` (500,000 by default)

## Explicitly excluded

PTY/stdin, SSH/multi-host execution, native Windows/macOS adapters, GUI/browser computer-use, LSP/CodeGraph, MCP aggregation, scheduler, desktop GUI, and an OS sandbox.

## Compatibility and migration

`hostspan-v1` tool names and input schemas are fixed for Alpha. A breaking tool-contract change requires a new toolset version and migration notes. Description/schema metadata changes alter `toolset_hash`; refresh the ChatGPT app after upgrading.

`0.2.0-alpha.10` does not change the `hostspan-v1` tool contract. Remote non-loopback serving still fails closed without OAuth. The OAuth HTTP surface is aligned with the MCP SDK shape (`/authorize`, `/token`, `/register`, `/revoke`) used by working ChatGPT integrations. Overload controls and audit caps are additive operational safeguards; existing configs remain valid because the new server/retention fields have runtime defaults.

Config schema remains version 1. The durable database schema is version 3; it retains hashed OAuth client/code/token state and adds an indexed audit-retention path. HostSpan fails closed if it encounters a newer database schema than the binary supports. Database initialization uses WAL and backs up an existing database before migration.

## Release gates

Before publishing an Alpha build:

```bash
pnpm install --frozen-lockfile
pnpm check
hostspan doctor
hostspan smoke --target <approved-test-target>
```

Also verify local MCP Inspector compatibility where available. ChatGPT Web end-to-end validation may depend on external Developer Mode/Secure MCP Tunnel availability; a client-side block with no HostSpan request trace is a compatibility incident rather than a HostSpan release blocker.
