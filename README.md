# HostSpan

<p align="center">
  <img src="assets/brand/hostspan.svg" width="128" height="128" alt="HostSpan controlled span icon">
</p>

[![CI](https://github.com/huhumanmaninganingansalamlam/hostspan/actions/workflows/ci.yml/badge.svg)](https://github.com/huhumanmaninganingansalamlam/hostspan/actions/workflows/ci.yml)
[![Desktop release](https://github.com/huhumanmaninganingansalamlam/hostspan/actions/workflows/release.yml/badge.svg)](https://github.com/huhumanmaninganingansalamlam/hostspan/actions/workflows/release.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

HostSpan is a terminal-first MCP execution gateway for ChatGPT Web Developer Mode. It exposes the versioned `hostspan-v3.5` toolset for approved local targets and explicitly enabled desktop control and keeps file/process side effects verifiable and recoverable across reconnects.

The HostSpan controlled-span mark uses the same geometry for the application and tray. The app places the white mark on a blue rounded tile; the tray uses a tightly framed monochrome mark, or the same blue tile when panel tint is unavailable.

HostSpan has native Linux x64, Windows x64, macOS x64, and macOS arm64 core paths. **Native execution is not an OS sandbox**: a child process runs with the permissions of the user running HostSpan. See [Security](SECURITY.md) before enabling `exec` on a target.

## Current scope

The MCP tool registry is versioned as `hostspan-v3.5` (v0.11.0):

`system_status`, `target_list`, `file_list`, `file_read`, `file_search`, `file_patch`, `process_start`, `process_poll`, `process_write`, `process_cancel`, `computer`, `process_list`.

Every file/process request names a persistent `target_id`; no ChatGPT session ID or temporary workspace handle is product state. File mutation uses expected SHA-256 values, dry-run/staging, per-file atomic replacement, a durable transaction journal, and postcondition hashes. Non-interactive commands use the durable native process supervisor. Interactive commands use the same `process_id` lifecycle through a HostSpan-owned, daemon-independent PTY session worker: start with `tty=true`, read through `process_poll`, write/resize through `process_write`, and close through `process_cancel`.

Linux x64 and both macOS architectures use Unix PTYs and POSIX process groups. Native Windows x64 uses ConPTY plus a Job Object-backed process-tree controller. WSL2 remains a Linux runtime and is not counted as Windows qualification. Linux x64, native Windows x64, and both native macOS architectures have passed the full core gate, installed CLI smoke, and packaged-runtime verification. The installed macOS arm64 app was also smoked on a separate native Mac. GUI observation/input/result verification has passed through the Linux Wayland portal backend in source and packaged runtimes; Windows/macOS GUI and browser DOM integration are not implemented. Multi-host routing, LSP/CodeGraph, and claims of sandboxed execution remain out of scope.

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

For a complete file, use `file_read(start_byte=0)` and continue from `next_byte` with the first response's `sha256` as `expected_sha256`. Byte pages preserve delimiters and complete Unicode characters; `returned_bytes` counts returned UTF-8 bytes, while `next_byte` is an offset in the source encoding. A changed file fails with `STALE_CONTENT`. Line-range reads retain their existing formatting; after a byte-capped line read, resume at `next_byte`, not the next line number.

Recover lost execution IDs with read-only `process_list(target_id, cwd)`; it lists active HostSpan-owned processes in that directory and descendants. Use `active_only=false` for completed work and the returned `cursor` for another page. Poll the recovered ID using its output cursors. `exit_code_scope=spawned_command` identifies the wrapper's exit status; read a nested program's result file separately. Continue polling while `has_more_output`; `output_expired` and dropped-byte counters distinguish expired or evicted history from empty output.

If your native client has no registered HostSpan `process_list` or `process_poll` tool, use the installed CLI on the HostSpan host as the same profile owner. A ChatGPT plugin connection does not itself register tools in a separate native client. The CLI uses the existing authenticated local daemon channel and the same polling handler; it does not start a process, attach a terminal, or require another OAuth flow:

```bash
hostspan process list --target TARGET --cwd project/relative/path --active-only false \
  --limit 100 --config /path/to/config.yaml
hostspan process poll --process ORIGINAL_PROCESS_ID --config /path/to/config.yaml \
  --stdout-cursor 0 --stderr-cursor 0 --wait-ms 1000 --max-bytes 65536
```

List defaults to active records only; use `--active-only false` for terminal and unknown records. Continue a truncated list with `--cursor` from that response. Listings contain lifecycle metadata, not command arguments, environment or output. Directory membership does not prove caller/task binding, and recorded state is not a fresh OS liveness check. Only existing configured targets and allowed paths are visible.

Use your retained cursors instead of `0` after an earlier read, then continue with `next_stdout_cursor` and `next_stderr_cursor`. `wait_ms` is 0–1500 (default 0); `max_bytes` is 1–4194304 (default 131072). `has_more_output` covers the available output at that response, not process completion. Read `state`, `exit_code` and `signal` separately; a successful CLI retrieval exits 0 even when the original command failed. `output_expired`, `stdout_dropped_bytes`, `stderr_dropped_bytes` and earliest cursors identify unavailable history. A missing or older daemon returns `TARGET_NOT_READY`; it never triggers a reconnect, restarts the daemon, or replays the command. Keep one recovery owner for the original process.

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

Process response budgets and execution lifetime are separate. `wait_ms` bounds response waiting and `max_bytes` bounds returned output. Omit `deadline_ms` to run without an implicit deadline, set it for an explicit timeout, or use `process_cancel`. `max_output_bytes` caps retained output; filling it stops capture, never the process. `output_budget` reports the retained bytes and remaining capacity. Later output is drained but not retained; human PTY attachments still receive live output. Redirect full logs to a target file when needed.

HostSpan also applies local overload and retention boundaries so several agents cannot amplify one burst into unbounded host work. Defaults are 128 in-flight MCP requests and 8 concurrent ripgrep searches with 16 queued; the search queue times out after 1 second. Search overflow returns retryable `SERVER_BUSY`. Native execution and PTY sessions each default to 16 concurrent processes per target; reaching capacity also returns retryable `SERVER_BUSY`. Existing configurations with explicit limits retain those values until changed and the daemon is restarted. Durable audit history is bounded by both `audit_days` and `max_audit_events` (500,000 by default). Completed process output expires after 60 minutes by default, the retained spool budget defaults to 1 GiB, and old operation response payloads are compacted after 14 days without deleting their idempotency-key tombstones. Once those payloads and retained output are gone, redundant completed process/patch detail rows are also pruned while the operation tombstone remains.

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
  max_concurrent_sessions: 16
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

`assets/brand/hostspan-mark.svg` is the shared canonical geometry. `pnpm icons` generates the app/tray SVG previews and platform PNG, ICO, and ICNS files. macOS uses black 16/32 px Template images with OS tint; Windows selects dark or white artwork using the system UI theme and updates it when the theme changes. Linux uses the same logo on a small blue app tile because Electron does not expose panel tint. See [Brand assets](docs/DISTRIBUTION.md#brand-assets) for generated paths. Linux x64, native Windows x64, and native macOS x64 run the HostSpan core directly; the Windows desktop does not delegate core operations to WSL2. The macOS x64 app has been installed and launched from `~/Applications/HostSpan.app`, including a live menu-bar status item.

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

The contract suite pins the approved hash for the versioned 12-tool `hostspan-v3.5` registry. Acceptance coverage exercises the MCP request/response flow; process coverage exercises PTY input, resize, polling, cancellation, and recovery. Windows also checks Job Object process-tree control and native path security.

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

## Desktop computer control

Use `hostspan computer status` to discover the saved setting and next step. `hostspan computer enable --config /path/to/config.yaml` (or `disable`) changes only that profile. Add `--json` for automation. These commands never restart a daemon: apply changes explicitly when existing work allows it. The dashboard provides **Save ON / Save OFF** controls and shows both saved and current ON/OFF status, including a pending restart. The existing Restart control applies the change after desktop owners have returned their calls; canceling restart leaves the current setting in force. Restart ends HostSpan desktop sharing, so Linux needs OS consent again on the next explicit open. Saving or starting with ON never opens a portal. `system_status.backends.computer` reports the running session.

Computer-use is **OFF by default** in new CLI and app profiles: no `computer` configuration means every `computer` observation/input/open call is denied by the runtime. File, process and terminal authority remains separately controlled; unrestricted native execution is still native OS-user authority, so this switch is not an OS sandbox. Existing explicitly enabled profiles remain ON during upgrade; no consent, live session, or saved grant is silently revoked.


The `computer` tool connects observation, input and a fresh PNG observation in the daemon's logged-in desktop. `hostspan computer enable` selects `wayland-portal` on Linux and `native` on macOS/Windows. Existing configurations do not silently enable desktop control. Remote OAuth callers need the explicit `hostspan.computer` scope; file/process grants do not grant screen access. Linux uses the OS screen-sharing dialog. macOS requires Screen Recording and Accessibility permission; Windows requires the interactive user desktop, not an SSH/service Session 0. Native capture and coordinates use the primary display. The selected screen bounds capture/coordinates, **not keyboard focus or application authority**; desktop actions are not confined by file target roots.

Linux requirements: `/usr/bin/python3` with PyGObject, dbus-python, GStreamer introspection and `pipewiresrc`, `videoconvert`, `pngenc`, `appsink`; a working session D-Bus and RemoteDesktop/ScreenCast portal backend. Exact text paste additionally requires the portal Clipboard interface and its session grant. macOS 14+ uses the bundled ScreenCaptureKit/CoreGraphics helper; Windows uses Windows PowerShell with Windows Forms/GDI and SendInput. OS permission, locked desktops, protected content and Windows UIPI still apply. Packages bundle helpers, not host desktop services. No display/security setup is changed automatically.

For private-IP access to another computer, run HostSpan in that guest's logged-in desktop with its normal loopback listener, then forward it through your existing authenticated SSH connection, for example `ssh -NT -o ExitOnForwardFailure=yes -L 127.0.0.1:13906:127.0.0.1:39393 user@100.64.0.6`. Connect your MCP client to `http://127.0.0.1:13906/mcp`. The screen belongs to that guest, not the SSH client. SSH carries the loopback connection; it does not move a Session 0 daemon into an interactive Windows session. A non-loopback HostSpan listener still requires OAuth.

Call `open`, retain `session_id`, then `observe` until consent completes. The image response includes `observation_id`, image dimensions and `coordinate_width/height`; convert resized image coordinates to the latter before clicking. Call `click`, `move`, `scroll`, `key` or `text` with that observation ID and a new idempotency key. `text` writes only the supplied UTF-8 text to the consented clipboard and pastes it; this replaces clipboard content and never reads/restores prior clipboard data. Input returns `dispatched` separately from `outcome_verified`; inspect the fresh image for the actual outcome. When a response is lost, reuse the identical key/arguments; an unknown delivery is never replayed. Call `close` to release the portal session.

Repeating `computer.open` recovers the existing session, including pending consent. Follow the response message and structured `next_action`. After failed/canceled consent, open again. If input was sent but observation failed, retry observation only while sharing is active. If the OS ends sharing, open a fresh consented session and observe before deciding on another input. If delivery is uncertain, inspect the screen before deciding on a new input. The same key never resends input. Desktop MCP text gives a concise status while structured content retains identifiers and exact next-call arguments.
