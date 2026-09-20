# HostSpan Alpha release notes

## Release contract

- Version: `0.3.0-alpha.1`
- Toolset: `hostspan-v3`
- MCP protocol target: `2026-07-28`
- Qualified core platforms: Linux x64 (Ubuntu 24.04 LTS / WSL2), native Windows x64, and native macOS x64
- Client target: ChatGPT Web Developer Mode
- Transport: loopback HostSpan + OpenAI Secure MCP Tunnel; optional user-managed HTTPS reverse proxy/ingress

## Included

- immutable 11-tool MCP registry and stable toolset digest
- persistent explicit `target_id` routing
- atomic config writes and target registry
- canonical guarded list/read/search with ripgrep degradation reporting
- SHA-256 guarded dry-run/apply patch, validators, journal, and startup recovery
- deterministic bounded Git status/diff wrapper
- one durable process lifecycle for native and HostSpan-owned PTY interactive processes
- `process_write` for PTY stdin/control keys/resize while retaining `process_poll` and `process_cancel`
- daemon-independent PTY session workers with authenticated local IPC and local human read-only/read-write attach
- PTY session reconciliation across HostSpan daemon restart
- native Windows ConPTY interactive sessions and Job Object-backed non-interactive process-tree control
- process-group deadline/cancel, byte cursors, UTF-8-safe output spool, idempotent submission
- SQLite WAL operation/process/transaction/audit state
- native exec policy with bounded exec-only allowlists, terminal-authority parity, and output/deadline/concurrency limits
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
- optional Electron tray/dashboard for daemon start/stop/restart, Doctor health, active work, workspace add/remove, login autostart, recent calls, and PTY attach
- desktop first-run initialization: a fresh tray install creates the standard default config if none exists, without overwriting existing config
- original MCP gateway/bridge vector branding with dedicated small-size tray artwork and deterministic PNG/ICO/ICNS generation
- Electron Builder packaging for Linux x64 AppImage/deb, Windows x64 NSIS/zip, and macOS arm64/x64 DMG/zip
- platform-aligned packaged runtime verification: full ASAR/CLI/native-SQLite smoke on Linux/macOS and Electron/ASAR package smoke on Windows
- tag-gated GitHub Actions release builds with version verification, portable CLI tarball, checksums, prerelease classification, and maintained GitHub Release publishing action

## Explicitly excluded

Multi-host routing, GUI/browser computer-use, LSP/CodeGraph, MCP aggregation, scheduler, and an OS sandbox. The small tray/dashboard is a local management surface, not computer-use automation.

## Known post-Alpha work

- configure Windows Authenticode and Apple Developer ID/notarization secrets for signed public downloads;
- qualify macOS arm64 on the matching release runner and add signing/notarization credentials;
- continue Windows file/ACL hardening beyond the current Alpha path/reparse/identity checks; WSL2 remains a Linux runtime and is not native Windows qualification;
- extend soak duration from the current functional/concurrency evidence to multi-day steady-state runs;
- add bounded JSONL rotation/archival for always-on installations (SQLite audit rows are already age/count bounded).

These items do not require additional MCP tools. The v3 Alpha qualifies Linux x64, native Windows x64, and native macOS x64 core paths.

## Compatibility and migration

`hostspan-v3` exposes the fixed 11-tool durable PTY lifecycle. Tool description/schema metadata is part of `toolset_hash`; refresh the ChatGPT app after upgrading.

`0.3.0-alpha.1` uses HostSpan-owned durable PTY session workers, adds native Windows ConPTY/Job Object execution, keeps workspace/capability configuration restart-gated, and retains fail-closed OAuth for non-loopback serving. Linux x64, native Windows x64, and native macOS x64 all pass their full applicable test/build gates. macOS x64 additionally passes fresh installed CLI doctor/full smoke, PTY start/write/exit, packaged runtime smoke, and installed menu-bar app verification.

Config schema remains version 1 with `terminal.backend: pty` as the only interactive backend. The durable database schema remains version 4. Database initialization uses WAL and backs up an existing database before migration.

## Release gates

Before publishing an Alpha build:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm audit:prod
pnpm package:smoke
pnpm desktop:make
pnpm desktop:smoke
hostspan doctor
hostspan smoke --target <approved-test-target>
```

Also verify local MCP Inspector compatibility where available. ChatGPT Web end-to-end validation may depend on external Developer Mode/Secure MCP Tunnel availability; a client-side block with no HostSpan request trace is a compatibility incident rather than a HostSpan release blocker.
