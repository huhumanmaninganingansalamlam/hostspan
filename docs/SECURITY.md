# HostSpan Alpha security model

## Trust boundaries

HostSpan treats model output and repository content as untrusted input. The local HostSpan configuration and policy are administrator-controlled authority. OpenAI Secure MCP Tunnel or a user-managed reverse proxy is transport only; neither replaces HostSpan target/file/exec authorization.

Every tool call is revalidated against the configured `target_id`, target capability, canonical target-relative path, file policy, exec profile, program/environment limits, deadlines/output limits, and idempotency ledger.

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

## Process boundary

- `process_start` is the only spawn path.
- Commands are argv arrays with `shell=false`; Alpha has no raw shell-string tool or PTY/stdin channel.
- Side-effect submissions require a UUIDv7 idempotency key and are deduplicated in SQLite by argument hash.
- A duplicate key with different arguments is rejected with `IDEMPOTENCY_CONFLICT`.
- Linux process groups receive TERM then KILL for cancel/deadline/output-limit handling.
- Crash boundaries are never converted to success. HostSpan uses `unknown` when spawn/side-effect status cannot be proven and `orphaned` when a live process group survives but daemon stream ownership was lost.

## Secrets and retention

Default target deny patterns cover `.env*`, private key extensions, and Git object storage. Configure additional project-specific deny globs as needed.

Audit records contain structured identifiers, digests, phases, and result metadata, not raw process stdout/stderr. Structured logs and support exports redact common token/password/private-key patterns and home-directory prefixes. Completed process output is retained for 60 minutes by default and is stored under the local HostSpan state directory, not in the support bundle.

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
- authorization responses include `iss` for authorization-server mix-up protection;
- `offline_access` is advertised and refresh tokens are issued for reconnects;
- rotating the approval secret revokes all outstanding access/refresh tokens;
- OAuth authorization query parameters and secrets are not emitted in HostSpan transport traces/support bundles.

MCP 2026-07-28 hardened authorization around issuer validation and is moving from Dynamic Client Registration toward client metadata documents. HostSpan currently supports public-client DCR for compatibility; rate-limit the public registration/authorization endpoints at the reverse proxy.

Security requirements for a user-managed proxy:

- forward `/mcp`, HostSpan OAuth discovery routes, and `/oauth/*`;
- keep `/healthz` and `/readyz` private by default;
- terminate HTTPS at a trusted proxy/gateway;
- rate-limit and apply WAF/network policy where appropriate;
- keep `allowed_hosts` narrow and aligned with the hostname/IP actually used by the proxy/client;
- prefer a private/LAN bind for an off-host proxy; use wildcard binds only when routing/firewall rules require them;
- do not mistake Host validation for authentication—HostSpan OAuth is mandatory for non-loopback serving, and firewall/TLS controls remain defense in depth;
- treat forwarded MCP calls as untrusted even after proxy authentication: HostSpan target/file/exec policy is still the final local capability boundary.

Reverse proxy transport does not make native execution safer. Any authenticated caller that reaches HostSpan can invoke the read/write/exec capabilities permitted by the configured target policy.

## Reporting

Use the repository security reporting channel for vulnerabilities. For compatibility bugs, collect `hostspan doctor` and `hostspan support-export`; review the bundle before sharing it.
