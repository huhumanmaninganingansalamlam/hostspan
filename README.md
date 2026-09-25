# HostSpan

<p align="center">
  <img src="assets/brand/hostspan.svg" width="128" height="128" alt="HostSpan gateway icon">
</p>

[![CI](https://github.com/huhumanmaninganingansalamlam/hostspan/actions/workflows/ci.yml/badge.svg)](https://github.com/huhumanmaninganingansalamlam/hostspan/actions/workflows/ci.yml)
[![Desktop release](https://github.com/huhumanmaninganingansalamlam/hostspan/actions/workflows/release.yml/badge.svg)](https://github.com/huhumanmaninganingansalamlam/hostspan/actions/workflows/release.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

HostSpan is a terminal-first MCP execution gateway for ChatGPT Web Developer Mode. It exposes a fixed `hostspan-v3.1` toolset for approved local targets and keeps file/process side effects verifiable and recoverable across reconnects.

The HostSpan mark represents an MCP gateway spanning two local endpoints through a central protocol-routing hub. The tray uses a separate simplified bridge/hub glyph so it stays legible at 16–32 px instead of shrinking the full application artwork.

HostSpan has native Linux x64, Windows x64, and macOS x64 core paths. **Native execution is not an OS sandbox**: a child process runs with the permissions of the user running HostSpan. See [Security](SECURITY.md) before enabling `exec` on a target.

## Current scope

The MCP tool registry is immutable for `hostspan-v3.1`:

`system_status`, `target_list`, `file_list`, `file_read`, `file_search`, `file_patch`, `process_start`, `process_poll`, `process_write`, `process_cancel`.

Every file/process request names a persistent `target_id`; no ChatGPT session ID or temporary workspace handle is product state. File mutation uses expected SHA-256 values, dry-run/staging, per-file atomic replacement, a durable transaction journal, and postcondition hashes. Non-interactive commands use the durable native process supervisor. Interactive commands use the same `process_id` lifecycle through a HostSpan-owned, daemon-independent PTY session worker: start with `tty=true`, read through `process_poll`, write/resize through `process_write`, and close through `process_cancel`.

Linux x64 and macOS x64 use Unix PTYs and POSIX process groups. Native Windows x64 uses ConPTY plus a Job Object-backed process-tree controller. WSL2 remains a Linux runtime and is not counted as Windows qualification. Linux x64, native Windows x64, and native macOS x64 have passed the full core gate, installed CLI smoke, and packaged-runtime verification. macOS arm64 remains release-runner qualified rather than locally hardware-qualified. GUI/browser computer-use, multi-host routing, LSP/CodeGraph, and claims of sandboxed execution remain out of scope.

## Requirements

For the packaged desktop app, HostSpan bundles its Node/Electron runtime and ripgrep. HostSpan does not require Git; explicitly authorized process commands can still run it if installed.

For the portable CLI package, use Node.js 22 or newer. Source development additionally uses Corepack + pnpm 12.4.2. Linux systemd is optional and is only needed for `hostspan service ...`.

OpenAI Secure MCP Tunnel is used for the standard ChatGPT Web connection path; a user-managed HTTPS reverse proxy is also supported.

## Build

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm icons
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
  --capabilities read,write,exec,terminal \
  --exec-profile native-dev
hostspan policy validate
hostspan doctor
hostspan smoke --target local-app
```

`hostspan init` writes the default config under `%APPDATA%\HostSpan\config.yaml` on Windows and `$XDG_CONFIG_HOME/hostspan/config.yaml` (or `~/.config/hostspan/config.yaml`) on Linux/macOS. Use `--config /path/to/config.yaml` or `HOSTSPAN_CONFIG` to select another file. Target creation/removal and policy changes are local admin operations; they are not MCP tools. Workspace capabilities are explicitly selected from `read`, `write`, `exec`, and `terminal`; selecting `terminal` does not silently add `exec`. Configuration keys outside the current schema are rejected.

The sample configuration and policy guidance are in [`examples/hostspan.example.yaml`](examples/hostspan.example.yaml) and [`examples/policy.example.yaml`](examples/policy.example.yaml).

Target `deny_globs` / `ignore_globs` use a deliberately portable policy syntax: forward-slash paths with literal characters plus `*`, `**`, and `?`. HostSpan rejects leading `!`, backslashes, bracket classes, and brace expansion so file tools and ripgrep interpret the same policy consistently.

Native and PTY commands inherit the HostSpan process's OS environment with caller-provided `env` entries taking precedence. HostSpan's internal Electron `ELECTRON_RUN_AS_NODE` bootstrap flag is not implicitly passed to user programs; callers can still set it explicitly. A headless service inherits its service environment, not a separate interactive desktop session.

File discovery follows the selected target's `ignore_globs`, `deny_globs`, and the tool's hidden-file setting. Directory names such as `dist` and `node_modules` are not unconditionally hidden: configure exclusions on the target when wanted. Search accepts valid regular expressions, including blank-line and match-all patterns; requested match/byte/deadline budgets and the shared search concurrency limit bound the work.

`file_read` may scan forward to a requested late line independently of the response `max_bytes`, but each call has a fixed 64 MiB line-scan ceiling. Requests beyond that bound fail explicitly with `reason=file_read_scan_limit`; use `file_search` to narrow the location first rather than turning one read into an unbounded filesystem scan.

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

HostSpan also applies local overload and retention boundaries so several agents cannot amplify one burst into unbounded host work. Defaults are 128 in-flight MCP requests and 8 concurrent ripgrep searches with 16 queued; the search queue times out after 1 second. Search overflow returns retryable `SERVER_BUSY`; process execution is independently bounded by each exec profile's `max_concurrent_processes`. Durable audit history is bounded by both `audit_days` and `max_audit_events` (500,000 by default). Completed process output expires after 60 minutes by default, the retained spool budget defaults to 1 GiB, and old operation response payloads are compacted after 14 days without deleting their idempotency-key tombstones. Once those payloads and retained output are gone, redundant completed process/patch detail rows are also pruned while the operation tombstone remains.

```yaml
server:
  max_inflight_mcp_requests: 128
  max_concurrent_searches: 8
  max_queued_searches: 16
  search_queue_timeout_ms: 1000

retention:
  completed_process_output_ttl_minutes: 60
  operation_result_days: 14
  audit_days: 30
  max_audit_events: 500000
  max_total_spool_bytes: 1073741824

terminal:
  backend: pty
  max_concurrent_sessions: 4
  attach_history_bytes: 65536
  max_output_bytes: 16777216
```

### Interactive terminal

Interactive terminal access is an explicit target capability: once a PTY is writable, the program inside it can become a shell, REPL, SSH client, debugger, or TUI. Start an interactive process with `process_start(..., tty=true)`. `process_poll` reads incremental output, `process_write` sends text/control keys or terminal resize updates, and `process_cancel` closes the durable PTY session. `process_write` also requires a UUIDv7 idempotency key so a transport retry cannot silently type the same characters twice.

Non-interactive `process_start` accepts program paths/names and explicit environment variables on targets with `exec` capability. Deadline, output, concurrency, cwd, idempotency, and process-lifecycle limits still apply.

The response includes local attach commands. A person can observe without writing:

```bash
hostspan terminal attach --process <process_id> --read-only
```

or attach read/write when deliberate human takeover is desired:

```bash
hostspan terminal attach --process <process_id>
```

The PTY session worker has a lifetime independent from the MCP daemon. Its local IPC endpoint is authenticated with per-session random material, output is durably spooled, and HostSpan reconciles the durable `process_id` to a surviving worker after daemon restart. Human read-only/write attach uses that same HostSpan session rather than an external terminal multiplexer.

### Keep HostSpan running

`hostspan serve` remains the foreground/debug form. For normal local use, the cross-platform daemon wrapper can keep the server detached:

```bash
hostspan daemon start
hostspan daemon status
hostspan daemon stop
```

On Linux you may still prefer the existing systemd user service commands.

### Tray companion

The optional tray companion is intentionally small: server start/stop/restart, version/PID, Doctor health checks, current activity, targets/workspaces, recent calls, login autostart, and interactive terminal attach. Workspaces can be added with explicit capabilities or removed when no process is active. For the trusted-local DevSpace-replacement workflow, Add Workspace selects `read` by default. Interactive `terminal` authority is deliberately opt-in because it grants the stronger native PTY boundary as the HostSpan OS user. Target and policy configuration is intentionally snapshotted when the daemon starts, so workspace/capability changes require a daemon restart before MCP uses them. The tray explains this boundary and warns that ordinary native processes are stopped by restart while durable PTY sessions remain alive and reconnect. It does not expose a new HTTP admin API and is not GUI computer-use.

```bash
pnpm desktop
```

The original HostSpan icon is generated from the checked-in SVG sources in `assets/brand`; platform PNG, ICO, and ICNS files are generated deterministically by `pnpm icons`. Electron supplies the tray/menu-bar surface on macOS, Windows, and Linux. Linux x64, native Windows x64, and native macOS x64 run the HostSpan core directly; the Windows desktop does not delegate core operations to WSL2. The macOS x64 app has been installed and launched from `~/Applications/HostSpan.app`, including a live menu-bar status item.

Create native desktop artifacts for the current operating system with:

```bash
pnpm desktop:make
pnpm desktop:smoke
```

Linux x64 produces AppImage and Debian packages, Windows x64 produces an NSIS installer and ZIP, and macOS produces separate Apple Silicon and Intel DMG/ZIP artifacts. `desktop:smoke` verifies packaged SQLite, bundled ripgrep, native PTY loading, the full local file/process workflow, and a real HostSpan `tty=true` start/write/resize/poll lifecycle. When Linux distributables are present, it extracts both the AppImage and `.deb` to temporary directories and repeats the smoke against each package. Tagging a commit as `v<package-version>` runs the cross-platform GitHub Actions release workflow, verifies that the tag matches `package.json` and points to a commit contained in `main`, builds the four desktop architecture lanes plus a portable CLI `.tgz`, generates `SHA256SUMS.txt`, and refuses to overwrite an existing release. Tags without a suffix publish stable releases; suffix tags publish prereleases. Current CI artifacts are unsigned; operating-system signing and notarization credentials can be added without changing the MCP contract. See [Desktop distribution](docs/DISTRIBUTION.md).

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

The standard topology is:

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
pnpm desktop:make
hostspan doctor
hostspan smoke --target local-app
```

The contract suite pins the approved hash for the fixed 10-tool `hostspan-v3.1` registry. Acceptance coverage exercises the MCP request/response flow; process coverage exercises PTY input, resize, polling, cancellation, and recovery. Windows also checks Job Object process-tree control and native path security.

## Security and support

- [Security policy and reporting](SECURITY.md)
- [Security model](docs/SECURITY.md)
- [ChatGPT Web / Secure MCP Tunnel / reverse proxy](docs/CHATGPT.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Release notes](docs/RELEASE.md)
- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Desktop distribution and release automation](docs/DISTRIBUTION.md)

When reporting an interoperability issue, attach `hostspan doctor` output and a redacted `hostspan support-export` bundle. Process stdout/stderr is not written to audit logs or support bundles.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
