# HostSpan Alpha security model

## Trust boundaries

HostSpan treats model output and repository content as untrusted input. The local HostSpan configuration and policy are administrator-controlled authority. OpenAI Secure MCP Tunnel and the optional Cloudflare Quick Tunnel exposure mode are transports only; neither replaces HostSpan target/file/exec authorization.

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

Alpha binds only to `127.0.0.1`. Host headers are validated by the MCP Fastify adapter and HostSpan fallback validation. Do not expose the local MCP port directly to a LAN or the public Internet.

The recommended remote path remains outbound-only OpenAI Secure MCP Tunnel. `hostspan expose` is a development convenience that launches an outbound Cloudflare Quick Tunnel to a **separate** loopback-only HostSpan instance. That instance exposes only a random capability path such as:

```text
https://random.trycloudflare.com/mcp/<256-bit-random-capability>
```

Security properties of this mode:

- the default `/mcp`, `/healthz`, and `/readyz` routes are not registered on the exposure instance;
- the full generated URL is a bearer capability and must be treated as a secret;
- the capability path is not written to HostSpan transport logs/support exports;
- restarting `hostspan expose` rotates both the Quick Tunnel hostname and the capability;
- this is not OAuth and is not intended as a production identity/access-control system;
- Cloudflare Quick Tunnel is a development/testing transport; production or stable deployments should use Secure MCP Tunnel or a separately administered authenticated tunnel.

Quick Tunnel transport does not make native execution safer. A caller that possesses the capability URL can invoke whatever read/write/exec capabilities the configured target policy already allows.

## Reporting

Use the repository security reporting channel for vulnerabilities. For compatibility bugs, collect `hostspan doctor` and `hostspan support-export`; review the bundle before sharing it.
