# Hardening and optimization roadmap

This document records agreed implementation direction before the remaining changes are built. It is not a statement that planned behavior is already available. The current public contract remains `hostspan-v3` until a separately verified implementation or breaking toolset version lands.

## Design goals

HostSpan should stay small, fast, and predictable under concurrent agent use. Prefer bounded native primitives and fewer model/tool round trips over new subsystems. Optimize measured hot paths before adding caches or background machinery. Keep internal backend boundaries narrow enough that future providers can be added without rewriting target policy, audit, idempotency, concurrency, and lifecycle rules.

## Baseline already landed on `dev`

- `hostspan-v3` remains a fixed 11-tool contract with a stable toolset hash.
- File mutation is hash-guarded, multi-file, journaled, atomic at replacement time, and postcondition-verified.
- Native processes and durable PTYs have explicit deadline/output/concurrency controls, durable idempotency, cancellation, and crash-boundary states.
- MCP, search, process, PTY, and Git inspection have bounded concurrency paths instead of unbounded spawning.
- Read-only Git inspection disables optional locks, fsmonitor, external diff/textconv paths, bounds output, and fails closed when working-tree content filters would execute helper programs.
- Desktop `terminal` authority is opt-in. The current desktop default still selects `read`, `write`, `exec`, and `git`; changing that default is planned below, not already active.

## Permission and authority plan

### Read-first workspace defaults

Change new workspace creation so only `read` is selected by default. `write`, `exec`, `git` while it exists as a dedicated capability, and `terminal` require explicit selection. Existing configured workspaces are not silently downgraded.

### Trusted exec without per-CLI registration

When a user explicitly grants trusted native `exec`, the normal developer workflow must not require registering `git`, `node`, `pnpm`, `python`, or other ordinary CLIs one by one.

Keep two policy modes conceptually distinct:

- **Trusted exec:** explicit workspace authority to run native programs as the HostSpan OS user, still bounded by cwd/target selection, deadlines, output budgets, concurrency, idempotency, process-tree cancellation, and audit.
- **Restricted exec:** optional executable/environment allowlists for users who deliberately want that narrower guardrail.

Executable allowlists are a policy guardrail, not an OS sandbox. The default trusted-development path should not pretend otherwise.

### Terminal authority

Keep writable PTY authority separate and stronger than non-interactive exec. It remains explicit opt-in and continues to use its own durable lifecycle.

### Git authority

Keep the hardened v3 read-only implementation fail-closed. Do not add Git write operations to the dedicated Git surface. For the next breaking contract, re-evaluate whether a dedicated `git_changes`/`git` capability is still worth its authority and maintenance cost versus using trusted `exec`.

### OAuth authority

Evolve the single broad OAuth scope toward least-privilege read/write/exec/terminal-class scopes without weakening target policy. Refresh must never increase granted authority.

## Concurrency and recovery plan

### Session fencing

Add a generation or lease value to long-lived process/PTY ownership so a stale agent, old handoff, or pre-takeover writer cannot mutate a newer session merely by supplying a fresh idempotency key.

### Recovery semantics

Continue treating unprovable crash-boundary outcomes as `unknown`, not success. Same-key retries join or replay durable state. Do not claim general exactly-once execution for arbitrary external side effects.

### Uniform backend limits

Every backend that can create host work should expose bounded deadline, output, concurrency, cancellation, and safe diagnostics. Keep PTY lifetime independent where required rather than forcing all providers through one generic process abstraction.

## Lightweight performance work

### 1. Measure before optimizing

Use bounded existing audit/telemetry data to establish p50/p95 tool latency, response bytes, busy/retry/output-limit rates, and result-to-next-call gaps. Do not collect raw file contents, secrets, full environment values, or command text merely for performance tuning.

Performance work is complete only when the same representative workflow shows a real reduction in latency, host work, or model/tool round trips without weakening correctness.

### 2. Reduce file-read cost

Stop once the requested range is satisfied. Avoid unnecessary whole-file scans, duplicate decoding, and hashes that the caller did not request.

Do not add a general content cache by default. If measured workloads show repeated reads as a real bottleneck, use only a small bounded cache tied to file identity/change metadata, requested range, and `policy_epoch`, with immediate invalidation after HostSpan writes.

### 3. Reduce follow-up tool calls

Return enough information from the operation that just happened for the model to make the next decision without immediately re-fetching the same state.

Examples include change paths and before/after hashes after patching, validator outcomes, process state/cursors/output budget/terminal reason, and useful search context. Do not turn this into speculative side effects or automatic retries of commands whose outcome matters.

### 4. Keep backend seams small

Preserve narrow file/search/process/terminal provider boundaries and apply the same resource-limit vocabulary across them. Do not introduce a large plugin framework merely for hypothetical extensibility.

The desired extension point is implementation substitution behind existing policy/lifecycle contracts, not a larger public tool surface.

## MCP contract evolution

Keep `hostspan-v3` stable while hardening behavior within its existing schema. Breaking changes belong to a new toolset version.

For the next contract revision:

- define output schemas for structured tool results;
- improve human-facing titles and descriptions so models can select tools with fewer mistakes;
- keep error code, retryability, and safe reason fields consistent;
- rename metadata whose name no longer matches its behavior;
- keep the public tool count small and re-evaluate the dedicated Git surface;
- add model-facing regression scenarios for correct tool selection, unnecessary calls, duplicate side effects, and authority escalation attempts.

## Future GUI computer-use seam

GUI/browser computer use is not part of the current public surface. Preserve the internals so it can later be added as a separate provider/capability without coupling it to file, exec, or PTY authority.

A future computer-use provider should be able to reuse:

- persistent target identity and policy epochs;
- explicit capability grants;
- audit/request correlation;
- bounded concurrency and cancellation;
- idempotent side-effect submission where the action permits it;
- session fencing/ownership rules;
- safe diagnostics and retention boundaries.

Screen observation and input authority should remain separate from existing file/process capabilities. No current MCP tool should be widened in anticipation of that feature.

## Implementation order

1. Change new-workspace default authority to `read`.
2. Introduce the trusted-exec path that does not require per-CLI allowlist registration; preserve restricted exec as an optional mode.
3. Establish the lightweight performance baseline.
4. Remove measured file-read waste.
5. Reduce redundant follow-up tool calls through better existing results.
6. Normalize backend deadline/output/concurrency/cancellation diagnostics.
7. Add session fencing and strengthen restart/handoff recovery.
8. Split OAuth scopes.
9. Design the next breaking MCP contract with output schemas and improved tool metadata.
10. Re-measure representative workloads and only then select further optimizations.

Each implementation item should remain a small independently verified task. Product changes accumulate on `dev`; release/deploy is a separate decision.
