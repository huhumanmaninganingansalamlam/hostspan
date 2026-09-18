# HostSpan Alpha security model

## Trust boundaries

HostSpan treats model output and repository content as untrusted input. The local HostSpan configuration and policy are administrator-controlled authority. OpenAI Secure MCP Tunnel or a user-managed reverse proxy is transport only; neither replaces HostSpan target/file/exec authorization.

Every tool call is revalidated against the configured `target_id`, target capability, canonical target-relative path, file policy, exec profile, program/environment limits, deadlines/output limits, and idempotency ledger.

Tool annotations remain truthful: file/process mutation tools are not relabeled as read-only to bypass a client's action controls. A client may filter which advertised tools it injects into a conversation, but weakening annotations or wrapping writes in a deceptively generic tool would only hide risk from the user; it would not create a dependable server-side workaround.

## Native execution is not sandboxed execution

Alpha supports `mode: native` only. A native child process runs as the same OS user as HostSpan and may be able to read files outside the target or use the network. `allowed_programs` and the environment allowlist reduce accidental or model-selected behavior; they are **not** a kernel/container/VM security boundary.

HostSpan therefore reports process results with:

```json
{
  "native_execution": true,
  "sandboxed": false
}
```

Do not describe Alpha as secure sandboxed execution. A future sandbox provider must enforce stronger policies rather than silently pretending native mode can enforce them.

## File boundary

- MCP paths must be target-relative; absolute paths, NULs, and leading traversal are rejected.
- Existing path components are canonicalized and symlink components are rejected.
- Reads use no-follow opening and recheck containment before returning the descriptor.
- Target deny globs are enforced by typed file tools and excluded from Git summaries/search scope.
- The active HostSpan config and its backup are protected from `file_patch` self-mutation.
- Patch apply requires an `expected_sha256`, stages all requested files before commit, validates before writes, performs per-file atomic replacement, verifies after hashes, and records a durable transaction journal.
- Multi-file patching is not advertised as a single filesystem transaction. Crash recovery reports `verified`, `rolled_back`, or `unknown` based on observed hashes.

## Process and terminal boundary

- `process_start` is the only spawn path.
- Non-interactive commands are argv arrays with `shell=false` and remain subject to the target exec profile's `allowed_programs`, env allowlist, deadline, output, and concurrency limits.
- `tty=true` is a separate authority path: the target must explicitly grant the `terminal` capability and HostSpan uses a private tmux server/socket to own the PTY.
- `process_write` is valid only for tmux-backed interactive processes. It can send text, selected control keys, and terminal resize updates. Every write requires its own UUIDv7 idempotency key; duplicate retries join/replay the original write, while an unprovable crash-boundary outcome becomes `PROCESS_UNKNOWN` and is never automatically retyped.
- A writable PTY is stronger than bounded exec. A shell, REPL, debugger, SSH client, or interpreter inside the PTY can execute operations that are not constrained by the native exec profile's `allowed_programs`. The `terminal` capability therefore grants native interactive terminal authority as the HostSpan OS user.
- `target_id` still determines the initial working directory and the authorization decision, but once interactive terminal authority is granted it is not a filesystem sandbox. A shell can change directories or access anything available to the HostSpan OS user.
- Side-effect submissions require a UUIDv7 idempotency key and are deduplicated in SQLite by argument hash.
- A duplicate key with different arguments is rejected with `IDEMPOTENCY_CONFLICT`.
- Linux process groups receive TERM then KILL for cancel/deadline/output-limit handling.
- Crash boundaries are never converted to success. HostSpan uses `unknown` when spawn/side-effect status cannot be proven and `orphaned` when a live process group survives but daemon stream ownership was lost.
- tmux-backed sessions intentionally survive HostSpan daemon shutdown/restart. Startup reconciliation keeps a live tmux pane `running`, records an exited pane's exit status, or uses `unknown` if the durable session reference no longer exists.
- Human attach uses the same private tmux session. `--read-only` is the safe observation mode. Writable human attach is deliberate shared ownership: human keystrokes bypass MCP idempotency and are not individually represented as MCP operations.

## Secrets and retention

Default target deny patterns cover `.env*`, private key extensions, and Git object storage. Configure additional project-specific deny globs as needed.

Audit records contain structured identifiers, digests, phases, and result metadata, not raw process stdout/stderr. Structured logs and support exports redact common token/password/private-key patterns and home-directory prefixes. Completed process output is retained for 60 minutes by default and is stored under the local HostSpan state directory, not in the support bundle.

SQLite audit history is bounded by both age and count: `audit_days` defaults to 30 and `max_audit_events` defaults to 500,000. Maintenance runs incrementally during normal request handling so sustained traffic reuses bounded SQLite pages instead of growing the durable audit table without limit.

Use restrictive OS permissions on the config/state directories and avoid expanding retention unless needed.

## Network exposure

Alpha defaults to `127.0.0.1`, but may bind to a specific interface, `0.0.0.0`, or `::` when the deployment requires LAN/container/reverse-proxy reachability. Host headers are always validated by the MCP Fastify adapter.

For wildcard binds, `allowed_hosts` is mandatory and configuration fails closed when it is empty. For a specific bind address, HostSpan derives the allowed Host from that address unless an explicit allowlist is configured. This is DNS-rebinding protection, not client authentication. **Any non-loopback HostSpan server additionally requires HostSpan OAuth and refuses to start without it.**

The recommended remote path remains outbound-only OpenAI Secure MCP Tunnel. If you instead operate a reverse proxy/ingress/tunnel gateway yourself, keep HostSpan on loopback when the proxy is local; otherwise bind HostSpan deliberately to a reachable private/specific/wildcard interface and restrict `allowed_hosts`. The proxy supplies public TLS/network controls while HostSpan supplies OAuth authorization.

### OAuth security boundary

- remote MCP uses authorization-code OAuth with mandatory PKCE S256;
- the local approval credential is random 256-bit material; config stores only a salted scrypt hash and the recoverable value lives only in a mode-`0600` local admin file;
- authorization codes, access tokens, and refresh tokens are persisted only as hashes;
- access tokens are short-lived (15 minutes by default);
- refresh tokens rotate on every successful refresh and replay of an old refresh token fails;
- OAuth tokens are bound to the configured MCP `resource` URL;
- HostSpan exposes the MCP-SDK-compatible root `/authorize`, `/token`, `/register`, and `/revoke` OAuth surface and advertises the `hostspan` scope;
- refresh tokens are issued and rotated for reconnects without requiring a separate `offline_access` scope;
- rotating the approval secret revokes all outstanding access/refresh tokens;
- OAuth authorization query parameters and secrets are not emitted in HostSpan transport traces/support bundles.

MCP 2026-07-28 hardened authorization around issuer validation and is moving from Dynamic Client Registration toward client metadata documents. HostSpan currently supports public-client DCR for compatibility; rate-limit the public registration/authorization endpoints at the reverse proxy.

Security requirements for a user-managed proxy:

- forward `/mcp`, HostSpan OAuth discovery routes, and the root OAuth endpoints `/authorize`, `/token`, `/register`, and `/revoke`;
- keep `/healthz` and `/readyz` private by default;
- terminate HTTPS at a trusted proxy/gateway;
- rate-limit and apply WAF/network policy where appropriate;
- keep `allowed_hosts` narrow and aligned with the hostname/IP actually used by the proxy/client;
- prefer a private/LAN bind for an off-host proxy; use wildcard binds only when routing/firewall rules require them;
- do not mistake Host validation for authentication—HostSpan OAuth is mandatory for non-loopback serving, and firewall/TLS controls remain defense in depth;
- treat forwarded MCP calls as untrusted even after proxy authentication: HostSpan target/file/exec policy is still the final local capability boundary.

Reverse proxy transport does not make native execution safer. Any authenticated caller that reaches HostSpan can invoke the read/write/exec capabilities permitted by the configured target policy.

The local Electron tray/dashboard does not open an additional network admin API. It reads the local config/SQLite state and invokes local daemon/terminal commands. On Windows it delegates these operations to the WSL2 `hostspan` CLI. Treat the desktop login/session as the trust boundary for that management UI.

Target and policy configuration is immutable for one daemon lifetime. The tray writes workspace additions/removals atomically, but the running MCP server continues enforcing the policy snapshot it started with until an explicit restart. This is intentional: HostSpan does not partially hot-reload authorization state while requests or processes are active. Restart confirmation reports the impact before proceeding—native processes are stopped during shutdown, while tmux-backed interactive sessions survive and are reconciled after startup. Add Workspace selects all capabilities by default for the trusted-local convenience profile; this includes native `exec` and `terminal` authority, so reduce the selection for lower-trust folders.

## Overload boundary

HostSpan fails bounded rather than spawning unbounded work under request bursts:

- `/mcp` admits at most `server.max_inflight_mcp_requests` requests at once (128 by default); excess HTTP requests receive `503` plus `Retry-After: 1`.
- `file_search` admits at most `server.max_concurrent_searches` ripgrep children (8 by default), queues at most `server.max_queued_searches` (16), and returns retryable `SERVER_BUSY` when the queue is full or waits longer than `server.search_queue_timeout_ms` (1 second).
- `process_start` remains separately bounded per target by the selected exec profile's `max_concurrent_processes`.
- tmux-backed interactive sessions are separately bounded by `terminal.max_concurrent_sessions` (4 by default) per target.
- `system_status` and readiness use lightweight SQLite responsiveness checks; full `PRAGMA integrity_check` remains in `hostspan doctor` rather than running on every status request.
- backend availability probes are cached briefly so status floods do not repeatedly spawn diagnostic child processes.

## Reporting

Use the repository security reporting channel for vulnerabilities. For compatibility bugs, collect `hostspan doctor` and `hostspan support-export`; review the bundle before sharing it.
