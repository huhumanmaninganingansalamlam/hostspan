# HostSpan release notes

## 0.8.2 release

- Align native and PTY per-target concurrency defaults at 16 from one shared default. Update example configurations; existing explicit settings must be updated and the daemon restarted to change live capacity.
- Check new process capacity before accepting an idempotency key. Saturation returns retryable `SERVER_BUSY` without permanently recording an unstarted operation as failed; identical retries can start once capacity frees. Existing accepted operations still replay while capacity is full.
- Record the native OS PID before a nonblocking start returns, so immediate cancellation stops the process instead of losing its launch identity.
- The shared admission path covers native execution, PTY sessions, and retained-output capacity. Public tool schemas/hash and database schema are unchanged.

## 0.8.1 release

- Preserve collected search results when a single ripgrep JSON record exceeds the bounded reader buffer; report partial results with `truncation_reason: backend_output` instead of failing the entire search. Apply the same record boundary regardless of pipe chunking.
- Determine search truncation from omitted results, not total backend metadata bytes. Complete empty searches remain complete even with a small response budget.
- Keep ordinary branch CI free of CLI/desktop packaging; PRs check native packaged runtimes and release workflows build installers.
- Public MCP `hostspan-v3.2` 10-tool contract/hash, configuration and database schemas are unchanged.

## 0.8.0 release

- Share native/PTY admission and durable launch bookkeeping; derive reserved capture capacity from active process records instead of maintaining a second in-memory ledger. PTY response-observation failures no longer mark a live process as failed, so identical retries and cancellation retain the same durable execution.

- Separate execution lifetime from response and capture budgets. `process_start` no longer supplies an implicit 30-second deadline; explicit `deadline_ms` and `process_cancel` still stop the process tree. New `process_start.max_bytes` bounds returned output independently of retained output.
- Filling `max_output_bytes` stops storing output, not the native or PTY process. Retained output remains bounded and readable; live human PTY attachments continue receiving output. `output_budget.scope` is now `retained_output`.
- Remove obsolete exec-profile fields: `default_deadline_ms`, `max_deadline_ms`, `default_output_bytes`, and `max_output_bytes`. Remove these four keys from existing `exec_profiles` before starting the new version; preserve target configuration and credentials. Do not remove the separate tool or terminal capture settings. No database migration is required.
- Consume ripgrep search results incrementally and stop at the requested response budget instead of buffering the full search. Clarify durable idempotency keys and per-process byte cursors; audit failed cursor requests with bounded diagnostics.
- Intentional public contract update to `hostspan-v3.2`, still exactly 10 tools; digest `sha256:026c4c60fbd4d556464fb867148c5dd190fd0e3d67b0787faa6c0a71b291c60f`. Refresh MCP client metadata after upgrading.

## 0.7.1 release

- Preserve the user's filesystem view and normal OS-authorized privilege transitions in generated systemd units by removing `PrivateTmp` and `NoNewPrivileges`. Existing Linux installations must regenerate the unit with the updated CLI (`hostspan service install --config <path>`) and restart the service after reviewing active work.
- Unify native and PTY environment inheritance, preserving host variables and explicit caller overrides without per-command or environment allowlists. Do not implicitly pass Electron's internal `ELECTRON_RUN_AS_NODE` bootstrap flag to user programs.
- Honor configured file exclusions instead of hiding directory names unconditionally. Allow valid blank-line and match-all searches within the existing result, deadline and concurrency budgets. Keep only the requested page of file-list result objects in memory.
- Report workspace readiness against the running daemon's target snapshot; recover native processes even when PTY is disabled. Defer recovery and retention until runtime activation.
- Preserve the active daemon's control socket/token when another instance starts; make status queries read-only and consolidate shutdown without masking termination errors. Audit-store construction no longer deletes history.
- Save only explicitly selected workspace capabilities; selecting `terminal` no longer silently adds `exec`. Existing configs are not rewritten.
- The public `hostspan-v3.1` 10-tool contract/hash and config/database schemas are unchanged. GUI computer use remains future scope.

## 0.7.0 release

- The retired full-authority OAuth `hostspan` scope is no longer accepted. Existing clients using it must authorize again with one or more granular scopes; omitting `scope` grants `hostspan.read`.
- Refresh tokens preserve or narrow existing granular authority and cannot return to the retired scope.
- Remove the retired `git` target capability, Git queue settings, and legacy exec-profile fields (`policy`, `allowed_programs`, `env_allowlist`) before upgrading. The 0.7.0 config loader rejects these fields and does not rewrite config files.
- The public MCP contract remains `hostspan-v3.1` with exactly 10 tools and toolset hash `sha256:adcd8ec1b5643dd1b0d4bcaf311d23560786ae33b5515777483ce5968e247a9f`. The durable database schema is unchanged.

## 0.6.0 published release

- Native `exec` no longer uses per-program or environment-variable allowlists. `restricted` profiles are rejected; legacy `policy`, `allowed_programs`, and `env_allowlist` fields are ignored in memory and remain in the config file. Remove them before upgrading to 0.7.0.
- The 0.6.0 loader still accepts and ignores the retired `git` target capability and Git queue fields from 0.5.0. Remove them before upgrading to 0.7.0.
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
