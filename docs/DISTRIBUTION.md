# Desktop distribution

HostSpan keeps the MCP server/tool contract separate from the optional Electron tray companion. Desktop packaging does not add, remove, or relabel MCP tools.

## Brand assets

The editable source assets are:

- `assets/brand/hostspan.svg` — full application icon;
- `assets/brand/hostspan-tray.svg` — monochrome tray/menu-bar mark.

Generate derived assets with:

```bash
pnpm icons
```

The generator writes platform PNG, ICO, and ICNS files under `assets/icons/`. Derived icons are intentionally ignored by Git because CI regenerates them from the reviewed SVG sources.

## Local packaging

Build an unpacked application for the current platform:

```bash
pnpm desktop:dir
```

Build distributable artifacts for the current platform:

```bash
pnpm desktop:make
```

Artifacts are written to `out/`:

| Platform | Artifacts |
| --- | --- |
| Linux x64 | AppImage, `.deb` |
| Windows x64 | NSIS installer, `.zip` |
| macOS Apple Silicon | `.dmg`, `.zip` |
| macOS Intel | `.dmg`, `.zip` |

On Linux, Windows, and macOS, the packaged Electron executable can also run the HostSpan CLI through `ELECTRON_RUN_AS_NODE=1`; this is how the packaged tray starts/stops the durable daemon without requiring a second embedded runtime. Native Windows no longer delegates core operations to WSL2.

On first launch, the desktop app creates the normal HostSpan default config when it does not already exist. Existing config is never overwritten. This makes a fresh installer immediately able to render its tray/dashboard and lets the user add a workspace without first running `hostspan init` in a terminal.

After creating an unpacked or distributable package, verify the package rather than only the source tree:

```bash
pnpm desktop:smoke
```

On a matching native host, the smoke script executes `dist/src/cli/index.js` from inside the packaged ASAR, checks the packaged version, opens packaged `better-sqlite3`, actually spawns a PTY through the packaged `node-pty` binding, and runs a minimal packaged CLI/config round trip. On Windows it additionally runs the Job Object probe. Cross-built Windows packages may still receive a static PE/ASAR/native-binding layout check when no native Windows runtime is available.

The Windows package-layout smoke can also be reproduced from Linux before tagging:

```bash
rm -rf out-win-cross
pnpm exec electron-builder --config electron-builder.yml --win dir --x64 --config.directories.output=out-win-cross
node scripts/smoke-packaged-cli.mjs --platform win32 --arch x64 --out-dir out-win-cross
rm -rf out-win-cross
```

The `--platform`, `--arch`, and `--out-dir` overrides are for static package validation. Full executable CLI/SQLite/PTY/Job smoke requires a matching native host runtime.

## Continuous integration

`.github/workflows/ci.yml` runs the complete code gate and then packages Linux desktop artifacts. A pull request fails if the Electron application can no longer be packaged.

`.github/workflows/release.yml` runs on a `v*` tag or manual dispatch for an existing tag. It:

1. checks out the tagged revision;
2. verifies that `v<package.json version>` exactly matches the tag;
3. runs the full `pnpm check` release gate on Ubuntu;
4. builds Linux x64, Windows x64, macOS Apple Silicon, and macOS Intel artifacts on matching native GitHub runners;
5. runs packaged CLI/native-SQLite/PTy smoke on each matching native runner and the Windows Job Object probe on Windows;
6. packs the npm/CLI payload as `hostspan-<version>.tgz`;
7. uploads the user-facing packages to one GitHub Release;
8. generates `SHA256SUMS.txt`;
9. marks tags containing `-` (for example, `v0.2.0-alpha.21`) as prereleases.

Create a release after the intended commit is on `main`:

```bash
git tag v0.3.0-alpha.1
git push origin v0.3.0-alpha.1
```

Do not move or reuse a published tag. Increment `package.json`, `src/version.ts`, and `docs/RELEASE.md` together before creating the next tag.

## Signing status

The current alpha workflow intentionally produces **unsigned** artifacts. Users may see Windows SmartScreen or macOS Gatekeeper warnings. Production signing requires repository secrets and external certificates:

- Windows Authenticode certificate/token;
- Apple Developer ID Application certificate;
- Apple notarization credentials.

Signing credentials must never be committed to the repository. Add them as GitHub Actions secrets and keep unsigned local/package tests available so contributors without certificates can still verify packaging.

## Platform scope

Packaging and native-core support are separate claims:

| Environment | Current core status |
| --- | --- |
| Linux x64 / Ubuntu 24.04 | release-qualified Alpha core; Unix PTY + process groups |
| WSL2 | uses the Linux core; not native Windows qualification |
| Windows x64 | native Alpha core; ConPTY + Job Objects; full Windows test/build and packaged-runtime smoke passed |
| macOS x64 | PTY session contract, CLI tarball, and packaged-runtime smoke passed; complete core qualification is still separate |
| macOS arm64 | release packaging lane exists; native PTY/package qualification relies on the release runner |

Packaging success must not be described as native-core security or process-recovery qualification.
