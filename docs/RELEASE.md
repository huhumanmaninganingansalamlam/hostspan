# HostSpan release notes

## 0.6.0 published release

- Native `exec` no longer uses per-program or environment-variable allowlists. Existing `restricted` exec profiles continue to load; obsolete allowlist fields are ignored and removed by the next config write. Operators who relied on those fields as an execution boundary should review target and OAuth authority before upgrading.
- Target `exec` capability, OAuth authority, and process resource limits remain in effect.
- The public MCP contract remains `hostspan-v3.1` with exactly 10 tools and the same toolset hash as 0.5.0. The database schema is unchanged.

## 0.5.0 published release

- Public MCP contract: `hostspan-v3.1`, exactly 10 tools, with `git_changes` removed.
- Toolset hash: `sha256:adcd8ec1b5643dd1b0d4bcaf311d23560786ae33b5515777483ce5968e247a9f`.
- The dedicated Git inspection runtime, queue, status output, and new-workspace Git capability selection are removed. Existing config files containing the old `git` capability or Git queue fields still load; that capability is ignored at runtime.
- `file_patch` still supports the optional `git_diff_check` validator. Explicit process execution can still run Git when the target's exec authority permits it.
- The database schema, process lifecycle, OAuth scopes, and remaining tool input schemas are unchanged. Refresh MCP clients after upgrading because the public tool list and hash changed.
- Published as the stable `v0.5.0` release from commit `5dc1f1f`.

## 0.4.0 published release

### Release contract

- Version: `0.4.0`
- Toolset: `hostspan-v3`
- MCP protocol target: `2026-07-28`
- Qualified core platforms: Linux x64 (Ubuntu 24.04 LTS / WSL2), native Windows x64, and native macOS x64
- Client target: ChatGPT Web Developer Mode
- Transport: loopback HostSpan + OpenAI Secure MCP Tunnel; optional user-managed HTTPS reverse proxy/ingress

### Included

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
- Windows guarded file read/replace parent pinning through native directory handles plus private DACLs for HostSpan config/state
- process-group/job deadline/cancel, UTF-8-safe process-output byte cursors, bounded UTF-8/UTF-16 file reads, idempotent submission
- SQLite WAL operation/process/transaction/audit state
- native exec policy with bounded exec-only allowlists, terminal-authority parity, and output/deadline/concurrency limits
- bounded JSONL rotation, redaction, short output retention, spool quota eviction, idempotency-result compaction, support export
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
- platform-aligned packaged runtime verification: version/SQLite/bundled-ripgrep/PTy/full-workflow smoke on native Linux, Windows, and macOS, including HostSpan `tty=true` lifecycle
- release-matrix installed-artifact verification: silent Windows NSIS installation and macOS DMG mount/copy followed by the same runtime smoke before artifacts are uploaded
- pinned `hostspan-v3` public toolset hash plus 100-exchange stability verification
- tag-gated GitHub Actions release builds with main-ancestry/version verification, portable CLI tarball, checksums, prerelease classification, and immutable GitHub Release publication
- four-platform native CI core/runtime smoke on Linux x64, Windows x64, macOS arm64, and macOS x64

### Explicitly excluded

Multi-host routing, GUI/browser computer-use, LSP/CodeGraph, MCP aggregation, scheduler, and an OS sandbox. The small tray/dashboard is a local management surface, not computer-use automation.

### Known distribution and operations work

- configure Windows Authenticode and Apple Developer ID/notarization secrets for signed public downloads;
- extend soak duration beyond the current functional/concurrency/recovery evidence for production-style multi-day steady-state measurement.

These items affect signed distribution and long-running operations. The core and packaged-runtime gates cover Linux x64, native Windows x64, native macOS x64, and native macOS arm64 on their matching CI/release runners.

### Contract and state policy

`hostspan-v3` exposes the fixed 11-tool durable PTY lifecycle. Its approved public toolset hash is pinned in the contract test, so a schema/description/annotation change cannot silently retain the v3 contract. Refresh the ChatGPT app after upgrading server versions.

`0.4.0` includes bounded Git inspection and process-output admission, stricter desktop IPC and terminal authority, granular OAuth scopes, durable approval requests, and PTY runtime ownership fencing with reliable human attach. The public `hostspan-v3` toolset and database schema remain unchanged. A maintenance pass also removes duplicate workspace capability logic, repeated spool/config reads, redundant admin queries, and repeated audit/Git scans.

`0.3.0-alpha.6` is the post-alpha.4 hardening baseline. It closes the audited late-line read (with a bounded 64 MiB line-scan ceiling), natural PTY slot reclamation, output-drain/termination recovery, runtime-reference cleanup, patch DB/journal crash-window, retention/quota, Windows ACL/path pinning, staged/rename Git summary, worker command-resolution, read-only diagnostic, and release-immutability gaps without changing the `hostspan-v3` MCP contract. Alpha.6 also fixes Darwin directory enumeration on native Apple Silicon by decoding the 64-bit `dirent` ABI rather than Intel's compatibility layout; the immutable alpha.5 tag exposed that failure in the hosted arm64 core gate and was not repointed.

Config schema remains version 1 with `terminal.backend: pty` as the only interactive backend. The durable database schema is version 5. Alpha.5 intentionally starts a fresh durable-state generation rather than interpreting older schema 1–4 databases: an unsupported schema is rejected without mutation instead of being migrated or guessed. SQLite runs in WAL mode.

Operation-result retention compacts large result/error payloads while preserving the idempotency-key tombstone, so expiration never turns an old side-effect key into permission to execute the side effect again. Completed process output/session artifacts are TTL-bounded and the retained spool budget evicts the oldest completed output before admitting unbounded growth. Redundant terminal process/patch detail rows are removed only after the associated artifacts are gone and the durable operation tombstone has been compacted.

### Release gates

Before publishing this release:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm audit:all
pnpm package:smoke
pnpm desktop:make
pnpm desktop:smoke
hostspan doctor
hostspan smoke --target <approved-test-target>
```

Also verify local MCP Inspector compatibility where available. ChatGPT Web end-to-end validation may depend on external Developer Mode/Secure MCP Tunnel availability; a client-side block with no HostSpan request trace is a compatibility incident rather than a HostSpan release blocker.
