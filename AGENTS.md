# HostSpan repository map for coding agents

HostSpan is a modular TypeScript MCP gateway for explicitly authorized local targets and consented desktop control. **Current public contract:** `hostspan-v3.5`, 12 tools, Node.js 22+, package version `0.13.2`. The source and tests are authoritative.

## Open the right owner first

| Task | Code owner | Focused evidence |
| --- | --- | --- |
| CLI parsing / operator commands | [`src/cli/index.ts`](src/cli/index.ts), [`src/cli/commands/`](src/cli/commands/) | [`test/cli/`](test/cli/) |
| Server lifecycle, DB state, readiness | [`src/runtime/create-runtime.ts`](src/runtime/create-runtime.ts), [`src/runtime/runtime-state.ts`](src/runtime/runtime-state.ts) | [`test/acceptance/workflow.test.ts`](test/acceptance/workflow.test.ts), [`test/security/`](test/security/) |
| MCP auth, HTTP validation, trace | [`src/mcp/server.ts`](src/mcp/server.ts), [`src/mcp/authentication.ts`](src/mcp/authentication.ts), [`src/mcp/routes.ts`](src/mcp/routes.ts) | [`test/auth/`](test/auth/), [`test/exposure/`](test/exposure/), [`test/contract/`](test/contract/) |
| Target file reads and guarded patch | [`src/files/`](src/files/), [`src/targets/`](src/targets/), [`src/policy/`](src/policy/) | [`test/files/`](test/files/) |
| Durable native / PTY execution | [`src/processes/supervisor.ts`](src/processes/supervisor.ts), [`src/processes/recovery.ts`](src/processes/recovery.ts), [`src/processes/snapshot.ts`](src/processes/snapshot.ts) | [`test/process/`](test/process/), [`test/recovery/`](test/recovery/) |
| GUI consent, worker JSON-lines | [`src/computer/portal.ts`](src/computer/portal.ts), [`src/computer/worker-protocol.ts`](src/computer/worker-protocol.ts) | [`test/computer/`](test/computer/) |
| Electron tray, daemon owner, IPC | [`src/desktop/main.ts`](src/desktop/main.ts), [`src/desktop/bootstrap.ts`](src/desktop/bootstrap.ts), [`src/desktop/ipc-handlers.ts`](src/desktop/ipc-handlers.ts) | [`test/desktop/`](test/desktop/) |
| Local admin / durable storage / diagnostics | [`src/admin/`](src/admin/), [`src/state/`](src/state/), [`src/observability/`](src/observability/) | [`test/admin/`](test/admin/), [`test/observability/`](test/observability/) |

Read [Architecture](docs/ARCHITECTURE.md) for dependency direction and exact request/lifecycle diagrams. [Local operations](docs/OPERATIONS.md) owns CLI recovery and admin commands; [Security](docs/SECURITY.md) owns threat boundaries; [Distribution](docs/DISTRIBUTION.md) owns packaging; [ChatGPT](docs/CHATGPT.md) owns tunnel/OAuth/proxy setup; [Troubleshooting](docs/TROUBLESHOOTING.md) owns diagnostic recovery.

## Gates

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm package:smoke
git diff --check
```

For focused work, use `pnpm exec vitest run test/<area>`. For desktop changes also run `pnpm desktop:dir` followed by `pnpm desktop:smoke` on a matching native OS and inspect the relevant native CI lanes. **`desktop:dir` clears `out/`; preserve previous build artifacts before running it.**

## Non-negotiable invariants

- Preserve public MCP tool names/schema/description, OAuth scopes, version hash, snake_case response fields and CLI exit/error contracts unless an explicitly approved contract version changes.
- Preserve UUIDv7 idempotency and durable process IDs. Do not replay a side effect whose delivery is uncertain, or label unknown/orphaned as succeeded.
- Enforce target capabilities, guarded file paths, private-token/OAuth authority, OS GUI consent and trusted Electron IPC independently. Native exec is **not** sandboxed.
- Respect runtime/PTY ownership, DB/token close order, startup failure cleanup, process-tree death and stdio drain. Do not turn races into time-based sleeps or weaken assertions.
- Validate external wire/JSON/IPC shapes before state mutation. Keep logs, support bundles and tests free of secrets, screenshots and private process output.
- Do not reset/stash unrelated work, rewrite existing QA evidence, publish artifacts, or force-push branches. Keep generated `dist/`, `out/`, `node_modules/` and private evidence out of product Git.
- Record the actual test outcome and any platform/credential/signing gate not run. A passing Linux unit suite is not Windows/macOS GUI qualification.

Prefer one coherent owner and a narrowly scoped test over new frameworks, duplicative docs, invented adapters or cosmetic file splits.
