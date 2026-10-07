# Security Policy

## Supported versions

Security fixes are directed to the latest published release and the `main` branch; older releases may not receive backports.

## Reporting a vulnerability

Do not include vulnerability details, credentials, private keys, OAuth tokens, target contents, or unreviewed support bundles in a public issue.

Prefer GitHub's private vulnerability reporting flow from the repository **Security** tab when it is available. If private reporting is not available, open a minimal public issue asking the maintainer for a private reporting channel without including exploit details.

For ordinary compatibility or correctness bugs, use the bug report template and attach only reviewed/redacted diagnostics.

## Security model

The detailed trust boundaries, native-execution warning, terminal authority, OAuth model, overload controls, retention behavior, and local admin assumptions are documented in [docs/SECURITY.md](docs/SECURITY.md).

HostSpan native execution runs with the permissions of the HostSpan OS user. It is not a kernel, container, or VM sandbox.
