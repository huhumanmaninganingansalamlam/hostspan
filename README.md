# HostSpan

HostSpan is a terminal-first MCP execution gateway for ChatGPT Web Developer Mode. It exposes a fixed `hostspan-v2` toolset for approved local targets and keeps file/process side effects verifiable and recoverable across reconnects.

HostSpan Alpha is intentionally Linux-first and **native execution is not an OS sandbox**. A native process runs with the permissions of the user running HostSpan. See [Security](docs/SECURITY.md) before enabling `exec` on a target.

## Alpha scope

The MCP tool registry is immutable for `hostspan-v2`:

`system_status`, `target_list`, `file_list`, `file_read`, `file_search`, `file_patch`, `git_changes`, `process_start`, `process_poll`, `process_write`, `process_cancel`.

Every file/Git/process request names a persistent `target_id`; no ChatGPT session ID or temporary workspace handle is product state. File mutation uses expected SHA-256 values, dry-run/staging, per-file atomic replacement, a durable transaction journal, and postcondition hashes. Non-interactive commands use the durable native process supervisor. Interactive commands use the same `process_id` lifecycle with a tmux-backed PTY: start with `tty=true`, read through `process_poll`, write/resize through `process_write`, and close through `process_cancel`.

Alpha is release-qualified on Ubuntu 24.04 LTS or WSL2 on Linux x64. GUI/browser computer-use, native Windows/macOS process adapters, multi-host routing, LSP/CodeGraph, and claims of sandboxed execution remain out of scope. Interactive terminal sessions are supported through tmux; a human can attach to the exact same session locally.

## Requirements

- Node.js 22 or newer
- Corepack + pnpm 12.4.2
- `git`
- `ripgrep` (`rg`) for `file_search`
- `tmux` for targets that enable the `terminal` capability
- systemd user services only if using `hostspan service ...`
- Electron dependencies only if using the optional system-tray companion (`pnpm desktop`)
- OpenAI Secure MCP Tunnel for the standard ChatGPT Web connection path

## Build

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/src/cli/index.js --version
```

During development, commands below can be run as `node dist/src/cli/index.js <command>`. After installing the package binary, use `hostspan <command>`.

## Quick start

Create the local admin config:

```bash
hostspan init
hostspan targets add \
  --id local-app \
  --label "Main application" \
  --root /absolute/path/to/project \
  --capabilities read,write,exec,git,terminal \
  --exec-profile native-dev
hostspan policy validate
hostspan doctor
hostspan smoke --target local-app
```

`hostspan init` writes the default config under `$XDG_CONFIG_HOME/hostspan/config.yaml` or `~/.config/hostspan/config.yaml`. Use `--config /path/to/config.yaml` or `HOSTSPAN_CONFIG` to select another file. Target creation/removal and policy changes are local admin operations; they are not MCP tools.

The sample configuration and policy guidance are in [`examples/hostspan.example.yaml`](examples/hostspan.example.yaml) and [`examples/policy.example.yaml`](examples/policy.example.yaml).

## Run the server

```bash
hostspan serve
```

Default endpoints:

```text
MCP       http://127.0.0.1:39393/mcp
Health    http://127.0.0.1:39393/healthz
Readiness http://127.0.0.1:39393/readyz
```

The default bind is loopback-only, but `server.listen_host` is configurable for LAN/container/reverse-proxy deployments. Host header validation remains enabled for every bind. **Any non-loopback HostSpan server additionally requires built-in OAuth and fails closed when OAuth is missing.** `readyz` represents server/database readiness; missing ripgrep is reported as degraded so non-search tools stay usable, while `file_search` returns `SEARCH_BACKEND_UNAVAILABLE`.

HostSpan also applies local overload boundaries so several agents cannot amplify one burst into unbounded host work. Defaults are 128 in-flight MCP requests, 8 concurrent ripgrep searches, 16 queued searches, and a 1-second search queue timeout. Search overflow returns retryable `SERVER_BUSY`; process execution is independently bounded by each exec profile's `max_concurrent_processes`. Durable audit history is bounded by both `audit_days` and `max_audit_events` (500,000 by default).

```yaml
server:
  max_inflight_mcp_requests: 128
  max_concurrent_searches: 8
  max_queued_searches: 16
  search_queue_timeout_ms: 1000

retention:
  max_audit_events: 500000

terminal:
  backend: tmux
  max_concurrent_sessions: 4
  history_limit_lines: 50000
  max_output_bytes: 16777216
```

### Interactive terminal

Interactive terminal access is an explicit target capability because it is stronger than bounded `exec`: once a PTY is writable, the program inside it can become a shell, REPL, SSH client, debugger, or TUI. Start an interactive process with `process_start(..., tty=true)`. `process_poll` reads incremental output, `process_write` sends text/control keys or terminal resize updates, and `process_cancel` closes the tmux session. `process_write` also requires a UUIDv7 idempotency key so a transport retry cannot silently type the same characters twice.

The response includes local attach commands. A person can observe without writing:

```bash
hostspan terminal attach --process <process_id> --read-only
```

or attach read/write when deliberate human takeover is desired:

```bash
hostspan terminal attach --process <process_id>
```

tmux runs on a HostSpan-private socket under the state directory, so ordinary user tmux sessions are not mixed with HostSpan sessions. tmux survives HostSpan daemon restart; HostSpan reconciles the durable `process_id` to the surviving session on startup.

### Keep HostSpan running

`hostspan serve` remains the foreground/debug form. For normal local use, the cross-platform daemon wrapper can keep the server detached:

```bash
hostspan daemon start
hostspan daemon status
hostspan daemon stop
```

On Linux you may still prefer the existing systemd user service commands.

### Tray companion

The optional tray companion is intentionally small: server start/stop, version/PID, targets/workspaces, recent calls, and interactive terminal attach. It does not expose a new HTTP admin API and is not GUI computer-use.

```bash
pnpm desktop
```

Electron supplies the tray/menu-bar surface on macOS, Windows, and Linux. The HostSpan core is currently release-qualified on Linux/WSL2; on Windows the tray controls the WSL2 `hostspan` CLI. macOS core support is a preview until its process/recovery suite is release-qualified.

To listen on a specific interface:

```yaml
server:
  listen_host: 192.168.10.20
  listen_port: 39393
  data_dir: ~/.local/state/hostspan
```

When binding a specific IP/hostname and `allowed_hosts` is omitted or empty, HostSpan accepts that bound host as the HTTP `Host` value. If clients use a different DNS name, list it explicitly.

To listen on all IPv4 interfaces, an explicit Host allowlist is required:

```yaml
server:
  listen_host: 0.0.0.0
  listen_port: 39393
  allowed_hosts:
    - mcp.example.com
    - 192.168.10.20
  data_dir: ~/.local/state/hostspan
```

`listen_host: ::` works the same way for all IPv6 interfaces and also requires non-empty `allowed_hosts`. Entries are hostname/IP values only—no scheme, path, or port.

Before starting any non-loopback/public deployment, initialize HostSpan OAuth with the exact public MCP URL:

```bash
hostspan oauth init --public-url https://mcp.example.com/mcp
```

The command adds the public hostname to `allowed_hosts`, persists only a salted scrypt hash of the approval credential, and writes the recoverable credential to a local mode-`0600` `approval_secret_file`. Access tokens are short-lived, refresh tokens rotate, and authorization-code/access/refresh token values are stored in SQLite only as hashes.

If you want a normal public MCP endpoint instead of Secure MCP Tunnel, run your own reverse proxy in front of HostSpan. A same-host proxy can keep HostSpan on loopback:

```text
MCP client
  -> https://mcp.example.com/mcp
  -> your nginx/Caddy/Traefik/ingress/reverse tunnel
  -> http://127.0.0.1:39393/mcp
```

Preserve the public `Host` header so HostSpan can validate it against the hostname added by `hostspan oauth init`. If your proxy runs in another container/VM/host, bind HostSpan to a reachable private IP or `0.0.0.0`/`::`; OAuth is still mandatory for that non-loopback server.

Example Caddy upstream:

```caddyfile
mcp.example.com {
    @hostspan path /mcp /.well-known/oauth-* /authorize /token /register /revoke
    reverse_proxy @hostspan 127.0.0.1:39393
}
```

Example nginx upstream:

```nginx
location ~ ^/(mcp|authorize$|token$|register$|revoke$|\.well-known/) {
    proxy_pass http://127.0.0.1:39393;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
    proxy_buffering off;
}
```

TLS, rate limits, WAF rules, and public DNS belong at your proxy/gateway. HostSpan itself is the OAuth authorization/resource server. The proxy must forward `/mcp`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource*`, `/authorize`, `/token`, `/register`, and `/revoke`. Keep `/healthz` and `/readyz` private.

Rotate the local OAuth approval credential and revoke all existing access/refresh tokens with:

```bash
hostspan oauth rotate-secret
```

Useful local commands:

```bash
hostspan status
hostspan status --verbose
hostspan admin snapshot
hostspan terminal list
hostspan daemon status
hostspan print-toolset
hostspan logs --follow
hostspan support-export ./hostspan-support.json
hostspan service install
hostspan service start
hostspan service status
```

## ChatGPT Web

The standard Alpha topology is:

```text
ChatGPT Web Developer Mode
  -> OpenAI Secure MCP Tunnel (outbound transport)
  -> http://127.0.0.1:39393/mcp
  -> HostSpan policy/file/process services
```

Start HostSpan, verify `hostspan doctor` and `hostspan smoke`, then configure the current OpenAI Secure MCP Tunnel to forward to the loopback MCP endpoint. Add the resulting tunnel endpoint to ChatGPT Developer Mode and run `system_status` first. If the HostSpan version/toolset changes, use the ChatGPT app's MCP Refresh flow before treating stale tool metadata as a server defect.

Alternatively, point ChatGPT at the HTTPS URL of a reverse proxy you operate after running `hostspan oauth init`. ChatGPT discovers HostSpan OAuth and opens the authorization page; approve it with the credential stored in the local `approval_secret_file`. The proxy only transports HTTPS; HostSpan validates OAuth and still enforces the same target/file/exec policy. See [ChatGPT connection](docs/CHATGPT.md) for concrete proxy requirements.

Detailed setup and trace-based troubleshooting are in [ChatGPT connection](docs/CHATGPT.md) and [Troubleshooting](docs/TROUBLESHOOTING.md).

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
hostspan doctor
hostspan smoke --target local-app
```

The contract suite reconnects and lists the fixed 11-tool `hostspan-v2` toolset 100 times. The Alpha acceptance suite also runs the 10-turn workflow 50 times and verifies stable toolset hashing and request/response trace coverage. tmux integration tests cover interactive input, resize/output polling, explicit terminal capability enforcement, and daemon-restart recovery.

## Security and support

- [Security model](docs/SECURITY.md)
- [ChatGPT Web / Secure MCP Tunnel / reverse proxy](docs/CHATGPT.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Alpha release and migration notes](docs/RELEASE.md)

When reporting an interoperability issue, attach `hostspan doctor` output and a redacted `hostspan support-export` bundle. Process stdout/stderr is not written to audit logs or support bundles.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
