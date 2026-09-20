# Contributing to HostSpan

Thanks for helping improve HostSpan.

## Before you start

HostSpan is intentionally a small, terminal-first MCP execution gateway. The fixed `hostspan-v3` tool surface is a compatibility contract, not an invitation to add one tool per feature. Prefer strengthening correctness, recovery, security boundaries, diagnostics, and platform support over growing the MCP surface.

For security-sensitive issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

Requirements:

- Node.js 22 or newer
- Corepack and pnpm 12.4.2
- Git
- ripgrep

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

For desktop packaging:

```bash
pnpm icons
pnpm desktop:make
pnpm desktop:smoke
```

## Pull requests

Keep changes focused and explain:

1. the problem being solved;
2. the user-visible behavior before and after;
3. security or recovery implications;
4. tests added or updated;
5. whether the MCP tool name/schema/description metadata changes.

Breaking tool-contract changes must use a new toolset version rather than silently changing `hostspan-v3`.

Please run `pnpm check` and `git diff --check` before opening a pull request. Packaging changes should also run the relevant desktop package smoke locally when possible.

## Design principles

- Never report an unprovable side effect as success.
- Keep target and capability boundaries explicit.
- Native and terminal execution are not OS sandboxes.
- Preserve durable idempotency and crash-recovery semantics.
- Keep resource use bounded under bursty/multi-agent workloads.
- Distinguish ChatGPT/client-side tool injection failures from HostSpan server failures.

By contributing, you agree that your contributions are licensed under the repository's Apache-2.0 license.
