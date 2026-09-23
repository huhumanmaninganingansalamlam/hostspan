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
- Target deny/ignore globs intentionally use one portable subset across HostSpan, ripgrep, and Git: forward-slash paths with literal characters plus `*`, `**`, and `?`. Leading `!`, backslashes, bracket classes, and brace expansion are rejected at config validation instead of receiving tool-specific meanings.
- `git_changes` is a dedicated bounded Git inspection path, not general process authority. It ignores inherited Git environment/config and user/system attributes, disables fsmonitor, optional locks, external diff, and text conversion, and preflights repo-local content filters before any working-tree comparison. A configured clean/process filter affecting the requested tracked scope fails closed without executing the helper.
- The active HostSpan config and its backup are protected from `file_patch` self-mutation.
- Patch apply requires an `expected_sha256`, stages all requested files before commit, validates before writes, performs per-file atomic replacement, verifies after hashes, and records a durable transaction journal.
- Multi-file patching is not advertised as a single filesystem transaction. Crash recovery reports `verified`, `rolled_back`, or `unknown` based on observed hashes.

## Process and terminal boundary

- `process_start` is the only general-purpose process spawn path. The separate `git_changes` implementation may spawn only its fixed, bounded read-only Git inspection commands under the restrictions above.
- Non-interactive commands are argv arrays with `shell=false`. On `exec`-only targets they remain subject to the target exec profile's `allowed_programs` and env allowlist in addition to deadline, output, and concurrency limits.
- `tty=true` is a separate authority path: the target must explicitly grant the `terminal` capability and HostSpan launches a daemon-independent PTY session worker.
- `process_write` is valid only for PTY-backed interactive processes. It can send text, selected control keys, and terminal resize updates. Every write requires its own UUIDv7 idempotency key; duplicate retries join/replay the original write, while an unprovable crash-boundary outcome becomes `PROCESS_UNKNOWN` and is never automatically retyped.
- A writable PTY is stronger than bounded exec. A shell, REPL, debugger, SSH client, or interpreter inside the PTY can execute operations that are not constrained by the native exec profile's `allowed_programs`. The `terminal` capability therefore grants native interactive terminal authority as the HostSpan OS user.
- When a target grants both `exec` and `terminal`, HostSpan treats that stronger terminal grant consistently: non-interactive `process_start` no longer rejects a program or explicit environment variable merely because it is absent from the exec profile allowlists. Resource/lifecycle controls still apply. This avoids a misleading policy where `bash` is forbidden in bounded exec while the same target can already start `bash` inside a writable PTY.
- `target_id` still determines the initial working directory and the authorization decision, but once interactive terminal authority is granted it is not a filesystem sandbox. A shell can change directories or access anything available to the HostSpan OS user.
- Side-effect submissions require a UUIDv7 idempotency key and are deduplicated in SQLite by argument hash.
- A duplicate key with different arguments is rejected with `IDEMPOTENCY_CONFLICT`.
- Linux process groups receive TERM then KILL for cancel/deadline/output-limit handling. Native Windows non-interactive processes are placed under a kill-on-close Job Object so descendants are controlled as one tree.
- Crash boundaries are never converted to success. HostSpan uses `unknown` when spawn/side-effect status cannot be proven and `orphaned` when a live process group survives but daemon stream ownership was lost.
- PTY sessions intentionally survive HostSpan daemon shutdown/restart because the session worker owns the terminal outside the daemon lifetime. Startup reconciliation keeps a live worker `running`, records an exited session's exit status after output drain, or uses `unknown` if the durable worker reference no longer exists.
- Human attach uses the same HostSpan PTY worker. `--read-only` is the safe observation mode. Writable human attach is deliberate shared ownership: human keystrokes bypass MCP idempotency and are not individually represented as MCP operations.
- The PTY local IPC protocol requires per-session random authentication material. On Unix it uses a private socket path; on Windows it uses a local named pipe plus the same token check.
- Windows path handling rejects absolute/UNC/device/ADS syntax and reparse-point escapes. Guarded file read/replace operations pin the authorized parent directory through a native Win32 directory handle without delete sharing, preventing that parent from being renamed out from under the operation, then recheck file/directory identity around open/replace. These checks protect the typed HostSpan file boundary; they do not turn native execution into an OS sandbox.
- On Windows, HostSpan removes inherited access from its config/backup/approval-secret files and durable state directory and grants FullControl only to the current user SID and LocalSystem. `hostspan doctor` fails when an existing HostSpan config/state path grants an unexpected principal access.

## Secrets and retention

Default target deny patterns cover `.env*`, private key extensions, and Git object storage. Configure additional project-specific deny globs as needed.

Audit records contain structured identifiers, digests, phases, and result metadata, not raw process stdout/stderr. Structured logs and support exports redact common token/password/private-key patterns and home-directory prefixes. JSONL logs rotate at a bounded file size and retain a bounded archive count. Completed process output is retained for 60 minutes by default and is stored under the local HostSpan state directory, not in the support bundle.

SQLite audit history is bounded by both age and count: `audit_days` defaults to 30 and `max_audit_events` defaults to 500,000. Maintenance runs incrementally during normal request handling so sustained traffic reuses bounded SQLite pages instead of growing the durable audit table without limit.

Process retention maintenance runs while the daemon is alive as well as at startup. Expired process spool/session artifacts are removed, the configured total spool budget evicts the oldest completed output when necessary, and new process output is rejected with retryable `SERVER_BUSY` if the budget cannot be brought under the configured cap without deleting active output. Old operation result/error payloads are compacted after `operation_result_days`, while their idempotency records remain so an expired response can never authorize replay of a previous side effect. Completed process rows and terminal patch-transaction detail are pruned only after their output/journal artifacts are gone and the corresponding operation payload has been compacted.

On Unix, keep normal restrictive ownership/mode semantics on HostSpan config/state directories. On Windows, HostSpan applies and verifies the private DACL described above. Avoid expanding retention unless needed.

## Network exposure

Alpha defaults to `127.0.0.1`, but may bind to a specific interface, `0.0.0.0`, or `::` when the deployment requires LAN/container/reverse-proxy reachability. Host headers are always validated by the MCP Fastify adapter.

For wildcard binds, `allowed_hosts` is mandatory and configuration fails closed when it is empty. For a specific bind address, HostSpan derives the allowed Host from that address unless an explicit allowlist is configured. This is DNS-rebinding protection, not client authentication. **Any non-loopback HostSpan server additionally requires HostSpan OAuth and refuses to start without it.**

The recommended remote path remains outbound-only OpenAI Secure MCP Tunnel. If you instead operate a reverse proxy/ingress/tunnel gateway yourself, keep HostSpan on loopback when the proxy is local; otherwise bind HostSpan deliberately to a reachable private/specific/wildcard interface and restrict `allowed_hosts`. The proxy supplies public TLS/network controls while HostSpan supplies OAuth authorization.

### OAuth security boundary

- remote MCP uses authorization-code OAuth with mandatory PKCE S256;
- the local approval credential is random 256-bit material; config stores only a salted scrypt hash and the recoverable value lives only in a mode-`0600` local admin file;
- a successful local authorization approval atomically consumes its pending request, so replaying the same approval cannot mint another code; an incorrect approval secret leaves the request pending for a later valid retry;
- authorization codes, access tokens, and refresh tokens are persisted only as hashes;
- access tokens are short-lived (15 minutes by default);
- refresh tokens rotate on every successful refresh and replay of an old refresh token fails;
- OAuth tokens are bound to the configured MCP `resource` URL;
- HostSpan advertises four least-privilege scopes: `hostspan.read` for status/targets/file observation/git diff/process polling, `hostspan.write` for file patching, `hostspan.exec` for non-TTY process start/native cancellation, and `hostspan.terminal` for TTY start/input/PTY cancellation;
- an authorization request that omits `scope` defaults to `hostspan.read`;
- the legacy `hostspan` scope remains accepted as a full-authority compatibility alias for existing clients, but it is no longer advertised and cannot be combined with granular scopes;
- refresh preserves or narrows authority only. A legacy `hostspan` refresh may migrate to granular scopes, but granular scopes cannot widen or refresh back to the legacy alias;
- OAuth scope checks and HostSpan target policy are independent boundaries: a token must authorize the tool class and the selected target must separately grant the underlying capability;
- the stable `hostspan-v3` tool list/schema/hash is unchanged by scope enforcement; tool authorization is checked at invocation time;
- HostSpan exposes the MCP-SDK-compatible root `/authorize`, `/token`, `/register`, and `/revoke` OAuth surface;
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

The local Electron tray/dashboard does not open an additional network admin API. It reads the local config/SQLite state and invokes local daemon/terminal commands on the same native host. Treat the desktop login/session as the trust boundary for that management UI. The renderer runs with context isolation, no Node integration, and Chromium sandboxing; renderer-created navigation and windows are denied, privileged IPC is accepted only from the dashboard's main frame, and IPC payloads are validated at runtime before daemon/config/terminal actions. The inline local dashboard also carries a restrictive CSP that denies network connections, frames, objects, and form navigation.

Target and policy configuration is immutable for one daemon lifetime. The tray writes workspace additions/removals atomically, but the running MCP server continues enforcing the policy snapshot it started with until an explicit restart. This is intentional: HostSpan does not partially hot-reload authorization state while requests or processes are active. Restart confirmation reports the impact before proceeding—ordinary native processes are stopped during shutdown, while durable PTY sessions survive and are reconciled after startup. Add Workspace selects `read`, `write`, `exec`, and `git` by default for the trusted-local convenience profile, while the stronger `terminal` authority is opt-in. Reduce the selection further for lower-trust folders.

## Overload boundary

HostSpan fails bounded rather than spawning unbounded work under request bursts:

- `/mcp` admits at most `server.max_inflight_mcp_requests` requests at once (128 by default); excess HTTP requests receive `503` plus `Retry-After: 1`.
- `file_search` admits at most `server.max_concurrent_searches` ripgrep children (8 by default), queues at most `server.max_queued_searches` (16), and returns retryable `SERVER_BUSY` when the queue is full or waits longer than `server.search_queue_timeout_ms` (1 second).
- `git_changes` admits at most `server.max_concurrent_git_changes` inspections (4 by default), queues at most `server.max_queued_git_changes` (8), and returns retryable `SERVER_BUSY` when the queue is full or waits longer than `server.git_queue_timeout_ms` (1 second). Each admitted inspection may run a small bounded set of read-only Git plumbing commands, so this separate limit prevents Git child-process amplification under multi-agent bursts.
- `process_start` remains separately bounded per target by the selected exec profile's `max_concurrent_processes`.
- PTY-backed interactive sessions are separately bounded by `terminal.max_concurrent_sessions` (16 by default) per target.
- `system_status` and readiness use lightweight SQLite responsiveness checks; full `PRAGMA integrity_check` remains in `hostspan doctor` rather than running on every status request.
- backend availability probes are cached briefly so status floods do not repeatedly spawn diagnostic child processes.

## Reporting

Use the repository security reporting channel for vulnerabilities. For compatibility bugs, collect `hostspan doctor` and `hostspan support-export`; review the bundle before sharing it.
