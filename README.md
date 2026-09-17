# HostSpan

HostSpan is a terminal-first MCP execution gateway for ChatGPT Web Developer Mode. It exposes a fixed `hostspan-v1` toolset for approved local targets and keeps file/process side effects verifiable and recoverable across reconnects.

HostSpan Alpha is intentionally Linux-first and **native execution is not an OS sandbox**. A native process runs with the permissions of the user running HostSpan. See [Security](docs/SECURITY.md) before enabling `exec` on a target.

## Alpha scope

The MCP tool registry is immutable for `hostspan-v1`:

`system_status`, `target_list`, `file_list`, `file_read`, `file_search`, `file_patch`, `git_changes`, `process_start`, `process_poll`, `process_cancel`.

Every file/Git/process request names a persistent `target_id`; no ChatGPT session ID or temporary workspace handle is product state. File mutation uses expected SHA-256 values, dry-run/staging, per-file atomic replacement, a durable transaction journal, and postcondition hashes. All process execution goes through one durable supervisor using argv execution (`shell=false`), idempotency keys, process groups, output cursors, deadlines, and honest `unknown`/`orphaned` recovery states.

Alpha supports Ubuntu 24.04 LTS or WSL2 on Linux x64. PTY/stdin sessions, SSH, native Windows/macOS, GUI automation, LSP/CodeGraph, and claims of sandboxed execution are out of scope.

## Requirements

- Node.js 22 or newer
- Corepack + pnpm 12.4.2
- `git`
- `ripgrep` (`rg`) for `file_search`
- systemd user services only if using `hostspan service ...`
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
  --capabilities read,write,exec,git \
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

The server is loopback-only and validates Host headers. `readyz` represents server/database readiness; missing ripgrep is reported as degraded so non-search tools stay usable, while `file_search` returns `SEARCH_BACKEND_UNAVAILABLE`.

Useful local commands:

```bash
hostspan status
hostspan status --verbose
hostspan print-toolset
hostspan logs --follow
hostspan support-export ./hostspan-support.json
hostspan service install
hostspan service start
hostspan service status
```

## ChatGPT Web

The supported Alpha topology is:

```text
ChatGPT Web Developer Mode
  -> OpenAI Secure MCP Tunnel (outbound transport)
  -> http://127.0.0.1:39393/mcp
  -> HostSpan policy/file/process services
```

Start HostSpan, verify `hostspan doctor` and `hostspan smoke`, then configure the current OpenAI Secure MCP Tunnel to forward to the loopback MCP endpoint. Add the resulting tunnel endpoint to ChatGPT Developer Mode and run `system_status` first. If the HostSpan version/toolset changes, use the ChatGPT app's MCP Refresh flow before treating stale tool metadata as a server defect.

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

The contract suite reconnects and lists the fixed toolset 100 times. The Alpha acceptance suite also runs the 10-turn workflow 50 times and verifies stable toolset hashing and request/response trace coverage.

## Security and support

- [Security model](docs/SECURITY.md)
- [ChatGPT Web / Secure MCP Tunnel](docs/CHATGPT.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Alpha release and migration notes](docs/RELEASE.md)

When reporting an interoperability issue, attach `hostspan doctor` output and a redacted `hostspan support-export` bundle. Process stdout/stderr is not written to audit logs or support bundles.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
