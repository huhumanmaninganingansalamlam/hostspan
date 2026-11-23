# HostSpan

<p align="center"><img src="assets/brand/hostspan.svg" width="128" height="128" alt="HostSpan icon"></p>

[![CI](https://github.com/huhumanmaninganingansalamlam/hostspan/actions/workflows/ci.yml/badge.svg)](https://github.com/huhumanmaninganingansalamlam/hostspan/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

HostSpan is a terminal-first Model Context Protocol (MCP) gateway for approved local files, durable processes, interactive PTYs, and **explicitly consented** desktop control. Version **0.13.2** exposes the 12-tool `hostspan-v3.5` contract with stable persistent `target_id` values.

**Native execution is not sandboxed.** Commands run with the HostSpan operating-system user's authority. File targets, command policy, scoped credentials, and GUI permissions are separate security boundaries; see the [security model](docs/SECURITY.md).

## Get started

The source/portable CLI requires Node.js 22+ and pnpm 12.4.2. The packaged desktop app includes its Node/Electron runtime and ripgrep. HostSpan supports Linux x64, Windows x64, and macOS x64/arm64 core paths; platform-specific desktop control requires a logged-in supported OS session.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/src/cli/index.js --version
```

After installing the CLI package, use `hostspan` instead of `node dist/src/cli/index.js`. Create a local-only profile and explicitly authorize your own project:

```bash
hostspan init
hostspan targets add \
  --id local-app --label "Main application" \
  --root /absolute/path/to/project \
  --capabilities read,write,exec,terminal \
  --exec-profile native-dev
hostspan policy validate
hostspan doctor
hostspan smoke --target local-app
hostspan serve
```

The default endpoints are `http://127.0.0.1:39393/mcp`, `/healthz`, and `/readyz`. A non-loopback listener requires explicit OAuth or a scope-limited private-token profile over an operator-approved encrypted transport; `none` authentication is loopback-only.

For normal local operation, use `hostspan daemon start|status|stop`. Optional desktop controls are **OFF by default** and must be enabled in a selected profile, followed by an explicit restart and live OS consent. No computer input is replayed on uncertain delivery.

## Tool and recovery model

The current registry in [`src/mcp/registry.ts`](src/mcp/registry.ts) exposes:

```text
system_status   target_list    file_list       file_read
file_search     file_patch     process_start   process_poll
process_write   process_cancel process_list    computer
```

File mutations are hash guarded and journaled. Process starts and writes use durable, UUIDv7-keyed idempotency records. Recover the **original** process ID with `process_list`, then consume `process_poll` output using separate byte cursors; do not infer success from a wrapper's exit code or missing output. Interactive terminals require an explicit `terminal` capability and `tty=true`.

For step-by-step commands, cursor semantics, retention and desktop control, see [Local operations](docs/OPERATIONS.md). For MCP client connection, OAuth and reverse-proxy examples, see [ChatGPT connection](docs/CHATGPT.md).

## Verify and contribute

```bash
pnpm check           # typecheck, lint, workers, tests and build
pnpm package:smoke   # pack/install CLI into a clean prefix
pnpm desktop:dir     # unpacked native desktop build
pnpm desktop:smoke   # packaged runtime and PTY smoke
git diff --check
```

Desktop packaging writes to `out/` and **cleans that directory**; preserve existing candidates before running `pnpm desktop:dir`. Local Linux checks do not substitute for the Windows/macOS CI matrix or OS-permission/hardware QA. See [Distribution](docs/DISTRIBUTION.md) and [Contributing](CONTRIBUTING.md).

## Documentation

| Purpose | Canonical source |
| --- | --- |
| Source modules, owners, safety boundaries, tests | [Architecture](docs/ARCHITECTURE.md) and [agent navigation](AGENTS.md) |
| Operator commands, process recovery and desktop consent | [Local operations](docs/OPERATIONS.md) |
| ChatGPT Web, Secure MCP Tunnel, OAuth and reverse proxy | [ChatGPT connection](docs/CHATGPT.md) |
| Authentication, files/processes/computer threat model | [Security model](docs/SECURITY.md) and [reporting policy](SECURITY.md) |
| Symptoms and recovery | [Troubleshooting](docs/TROUBLESHOOTING.md) |
| Native packages, unsigned builds and signing | [Distribution](docs/DISTRIBUTION.md) |
| Release history / version qualification | [Release notes](docs/RELEASE.md) |
| Future **unshipped** contract proposal | [MCP v4 design](docs/MCP_V4_DESIGN.md) |

The system of record for shipped behavior is the source and its tests, not draft designs or old release notes.

Apache-2.0 — [LICENSE](LICENSE). See also [Code of Conduct](CODE_OF_CONDUCT.md).
