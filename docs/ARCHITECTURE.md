# HostSpan implementation architecture

This is the **current 0.13.2 / `hostspan-v3.5` source map**, not an aspirational framework. The MCP registry has 12 named tools. [`src/version.ts`](../src/version.ts) and [`src/mcp/registry.ts`](../src/mcp/registry.ts) define the shipped version, schemas and hash. [MCP v4](MCP_V4_DESIGN.md) is an unshipped proposal.

## Responsibility and dependency direction

```text
MCP HTTP adapter      CLI adapter       Electron tray/renderer
  src/mcp/              src/cli/            src/desktop/
        \\                  |                    /
                     src/runtime/
       configuration, targets, policy, auth, files,
       processes, computer, operations, state, logging
```

The runtime is a **composition root**, not an authority shortcut. Domain modules must not depend on CLI/desktop/MCP adapter implementations. Database repositories store durable records; request-level authorization is enforced before the domain operation. The Electron dashboard uses local authenticated daemon control, **not** a public HTTP admin API.

| Boundary | Owner | Contract |
| --- | --- | --- |
| CLI root and command families | [`src/cli/index.ts`](../src/cli/index.ts), [`src/cli/commands/`](../src/cli/commands/) | Parse arguments; preserve stdout/stderr, numeric exit codes and profile identity |
| Runtime state and activation | [`src/runtime/runtime-state.ts`](../src/runtime/runtime-state.ts), [`src/runtime/activation.ts`](../src/runtime/activation.ts), [`src/runtime/create-runtime.ts`](../src/runtime/create-runtime.ts) | Protected configuration, SQLite/token owners, generation fencing, recovery, orderly close |
| Tool dispatch and observability | [`src/runtime/tool-handlers.ts`](../src/runtime/tool-handlers.ts), [`src/runtime/tool-tracing.ts`](../src/runtime/tool-tracing.ts) | Per-call policy checks, safe bounded audit metadata |
| HTTP transport | [`src/mcp/server.ts`](../src/mcp/server.ts), [`src/mcp/authentication.ts`](../src/mcp/authentication.ts), [`src/mcp/routes.ts`](../src/mcp/routes.ts), [`src/mcp/request-validation.ts`](../src/mcp/request-validation.ts) | Host allowlist, auth modes, input budget, MCP SDK envelopes and rejection semantics |
| HTTP request observation and load | [`src/mcp/transport-observation.ts`](../src/mcp/transport-observation.ts) | Inflight admission, request ID, response/close-before-finish tracing |
| Target/file policy | [`src/targets/`](../src/targets/), [`src/policy/`](../src/policy/), [`src/files/`](../src/files/) | Root confinement, capability and deny rules, SHA-guarded journaled patches |
| Process admission and execution | [`src/processes/supervisor.ts`](../src/processes/supervisor.ts), [`src/processes/admission.ts`](../src/processes/admission.ts), [`src/processes/worker-launch.ts`](../src/processes/worker-launch.ts), [`src/processes/direct-native-launch.ts`](../src/processes/direct-native-launch.ts) | Durable idempotency, capacity, native/PTY child ownership |
| Process output and termination | [`src/processes/snapshot.ts`](../src/processes/snapshot.ts), [`src/processes/completion.ts`](../src/processes/completion.ts), [`src/processes/termination.ts`](../src/processes/termination.ts), [`src/processes/recovery.ts`](../src/processes/recovery.ts) | Byte cursors, dropped/expired history, process-tree death, unknown/orphan classification |
| Computer Use | [`src/computer/portal.ts`](../src/computer/portal.ts), [`src/computer/worker-protocol.ts`](../src/computer/worker-protocol.ts), [`src/computer/session-state.ts`](../src/computer/session-state.ts) | OS consent, validated worker replies, immutable observation ID, no auto-replay |
| Tray and local admin | [`src/desktop/main.ts`](../src/desktop/main.ts), [`src/desktop/bootstrap.ts`](../src/desktop/bootstrap.ts), [`src/desktop/tray-controller.ts`](../src/desktop/tray-controller.ts), [`src/desktop/ipc-handlers.ts`](../src/desktop/ipc-handlers.ts) | Single-instance lock, login daemon, trusted renderer IPC and consent-safe status |
| Persistence/observability | [`src/state/`](../src/state/), [`src/observability/`](../src/observability/) | SQLite repositories, retention, redacted audits and diagnostics |

## Key flows and failures

### File mutation

MCP receives validated `file_patch` arguments → runtime handler selects a writable target → policy/path guard confines the file → [`FilePatchService`](../src/files/patch.ts) checks expected SHA and stages a journal → atomic replacement verifies the postcondition → durable operation state/audit records the exact outcome. Replay with the same idempotency key cannot change arguments; a mismatch is rejected. Tests: [patch](../test/files/patch.test.ts), [path security](../test/files/path-security.test.ts), [idempotency](../test/idempotency/operations.test.ts).

### Process lifecycle

```text
request + UUIDv7 key
  -> target capability / exec profile / PTY reservation (admission)
  -> durable key resolution (new | replay | join | unknown)
  -> accepted / launching record
  -> durable native/PTY worker or direct platform process
  -> running -> succeeded | failed | cancelled | timed_out | orphaned | unknown
  -> output/retention snapshot + independent stdout/stderr byte cursors
```

A terminal record must not become active again. A missing worker, unconfirmed launch or unprovable stop is **never** success. Process-group and stdio closure are independent facts. The PTY/native worker can outlive the MCP daemon and is reconciled by original process ID and generation after restart. Tests: [launch races](../test/process/launch-reconcile-race.test.ts), [termination](../test/process/supervisor-termination.test.ts), [output](../test/process/supervisor-output.test.ts), [recovery](../test/process/supervisor-recovery.test.ts), [PTY attach](../test/process/pty-attach.test.ts).

### Authentication and HTTP

`authentication.mode=none` only serves loopback. Public OAuth and private-direct tokens never fall back to local authority. Non-loopback private-direct listeners require exact IP, allowed hosts, and an explicit assertion of encrypted private transport. Authorization and scopes are checked independently from target policy and per-tool capability. Transport bounds request volume before dispatch; validation failure, HTTP 401/503, content type, request IDs and modern MCP stamps retain distinct wire behavior. Tests: [OAuth](../test/auth/oauth.test.ts), [token](../test/auth/private-token.test.ts), [scopes](../test/auth/oauth-tool-scope.test.ts), [reverse proxy](../test/exposure/reverse-proxy.test.ts), [overload](../test/overload/overload.test.ts).

### Desktop control and tray

The `computer` tool is OFF for new profiles. After explicit enable and daemon restart, the OS obtains live consent in a logged-in desktop; only a fresh screenshot observation allows an input action. [`worker-protocol.ts`](../src/computer/worker-protocol.ts) validates newline-JSON events/replies from [Python](../src/computer/portal-worker.py), [Swift](../src/computer/native-macos.swift) or [PowerShell](../src/computer/native-windows.ps1). Input uncertainty persists across reconnect; never resend it automatically. The desktop tray's [`main.ts`](../src/desktop/main.ts) acquires the single-instance lock before registering IPC or starting the daemon; controller teardown removes IPC handlers/timers. Tests: [portal](../test/computer/portal.test.ts), [protocol](../test/computer/worker-protocol.test.ts), [desktop](../test/desktop/).

## Verification, release boundaries and maintenance

```bash
pnpm check
pnpm package:smoke
pnpm desktop:dir
pnpm desktop:smoke
git diff --check
```

`pnpm check` exercises Linux on the current host; the [CI workflow](../.github/workflows/ci.yml) covers Windows x64, Linux x64 and native macOS arm64/x64 runners. The desktop packaging command **clears `out/`**, so preserve previous candidates first. Native OS permission dialogs, installed-system integration, signing and notarization are distinct gates; do not substitute mocked tests for them. See [Distribution](DISTRIBUTION.md) and [Release notes](RELEASE.md).

During each significant maintenance review: inspect changed composition functions and cross-layer imports, expired structural exceptions, duplicate commands/docs, test skips/flakiness and private QA artifact growth. Preserve existing evidence, open a narrow issue or workspace Task for findings, and avoid a background auto-cleanup bot. Structural checks are in [the quality scripts](../scripts/) and executed by `pnpm check`; rules should be revised with a counterexample, not silenced by blanket exemptions.

### Machine-enforced architecture and documentation rules

The current [architecture policy](../.quality/architecture-policy.json) pins prohibited adapter imports, exact size budgets for composition entrypoints and cohesive legacy modules, finite exported response types, two narrowly reviewed platform/SQLite type assertions, and product-root evidence hygiene. The [architecture checker](../scripts/check-architecture.mjs) parses TypeScript imports, declarations, and casts rather than grading prose or rewriting source. The [documentation checker](../scripts/check-docs.mjs) verifies local document destinations and headings, current toolset/version references, entrypoint document size and the unshipped MCP v4 banner.

Run `pnpm check:architecture` and `pnpm check:docs` locally; both are included in `pnpm check` and therefore in the existing four-platform CI Check step. Synthetic [guardrail tests](../test/architecture/guardrails.test.ts) prove that a forbidden import, raw exported record, oversized entrypoint, stale exception, broken link, and product-root private artifact fail with concrete remediation. Exception changes must name one exact file, an owner, a technical reason and a removal/review trigger. Avoid wildcard suppressions or fabricated test approvals.
