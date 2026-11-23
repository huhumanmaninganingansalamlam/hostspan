# Contributing to HostSpan

HostSpan is a terminal-first MCP execution gateway. Current package `0.13.2` advertises 12 tools under `hostspan-v3.5`; `v3.3` and `v3.4` describe historical releases, not the current registry. The [architecture map](docs/ARCHITECTURE.md), [agent navigation](AGENTS.md) and source/tests are the current technical references.

Report vulnerabilities privately following [SECURITY.md](SECURITY.md). For public bugs, include the observed and expected result, reproduction steps, OS/runtime, version/build and a sanitized error/request ID **when available**; never paste tokens, private files, raw process output or unreviewed support bundles. Public GitHub issues cover user bugs and features. Internal implementation Tasks are tracked by the workspace repoctl records, not by a second GitHub Task issue template.

## Branch and release model

- `main` is the last qualified release baseline, not a feature-development branch. Changes are promoted through pull requests after the candidate satisfies the current CI matrix, installer/CLI smoke, dependency audit, security/recovery review and release notes. Use **squash merge** for coherent history; do not bypass required checks or directly push/force-push/delete `main`.
- `dev` integrates reviewed work. Small changes may follow the existing **non-force direct integration** flow; focused topic branches and PRs are welcome. Never force-push or rewrite collaborators' `dev` history. Do not impose `main`-style PR-only gates on `dev` without a tested replacement.
- Release tags must match a new `package.json` version, point to a commit on `main`, and must not overwrite an existing release. [Distribution](docs/DISTRIBUTION.md) covers unsigned builds, OS signing and notarization; [Release notes](docs/RELEASE.md) owns historical qualification.
- A solo maintainer need not manufacture another review approval; **passing automated checks and concrete verification evidence** matter more than an empty checkbox.

## Local setup and verification

Use Node.js 22+, Corepack, pnpm 12.4.2 and the native prerequisites for the target operating system:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
git diff --check
```

Run focused tests for changed boundaries before the full check, e.g. `pnpm exec vitest run test/process`. For a CLI/package change run `pnpm package:smoke`. For an Electron/package change run `pnpm desktop:dir` and `pnpm desktop:smoke` on the target OS. **The desktop build cleans `out/`**; preserve any valuable previous binaries first. CI runs native Linux x64, Windows x64 and macOS arm64/x64 jobs; see the exact current job names and gates in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

A local Linux PASS does not imply native Windows/macOS GUI permission, installer, package signing or hardware QA. Record actual commands, outcomes, test skips and blocked external gates in the PR description. Do not claim unrun jobs passed.

## PR description

Explain the problem and user impact, the exact code boundary changed and why it owns the behavior, the verification actually performed (including failures fixed), compatibility/security/recovery effects, and any Task/issue, rollout or rollback plan. Do **not** reproduce the CI status as checkboxes. Changes to the public MCP tool name/schema/description or authority must have explicit version and policy review.

## Design invariants

- No successful response for an unproven side effect. Preserve durable idempotency, byte cursors, unknown/orphaned states and process-tree/stdio termination rules.
- Native process execution is **not** OS sandboxing. Target/policy authority, OAuth/private-token scopes, and OS GUI consent are independent.
- Do not weaken request validation, exact Host allowlists, Windows ACLs, trusted Electron IPC or private data redaction for convenience.
- Retain old QA evidence and release history, and do not add a new framework, giant helper, stale copied command page or unused configuration switch to make a refactor look tidier.
- Keep changes independently reviewable. Avoid tests that sleep through races or mock away actual lifecycle boundaries.
