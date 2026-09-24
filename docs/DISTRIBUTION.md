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

On a matching native host, the smoke script executes `dist/src/cli/index.js` from inside the packaged ASAR, checks the packaged version, opens packaged `better-sqlite3`, verifies bundled ripgrep, actually spawns a PTY through the packaged `node-pty` binding, runs the full HostSpan Doctor/workflow smoke, and exercises a real HostSpan `tty=true` start/write/resize/poll lifecycle. On Windows it additionally runs the Job Object probe. Cross-built Windows packages may still receive a static PE/ASAR/native-binding layout check when no native Windows runtime is available.

The Windows package-layout smoke can also be reproduced from Linux before tagging:

```bash
rm -rf out-win-cross
pnpm exec electron-builder --config electron-builder.yml --win dir --x64 --config.directories.output=out-win-cross
node scripts/smoke-packaged-cli.mjs --platform win32 --arch x64 --out-dir out-win-cross
rm -rf out-win-cross
```

The `--platform`, `--arch`, and `--out-dir` overrides are for static package validation. Full executable CLI/SQLite/PTY/Job smoke requires a matching native host runtime.

## Continuous integration

`.github/workflows/ci.yml` runs the complete core gate, fresh CLI package smoke, unpacked Electron packaging, and packaged-runtime smoke on Linux x64, Windows x64, macOS Apple Silicon, and macOS Intel. Linux additionally builds the distributable AppImage/deb pair on ordinary CI. A pull request therefore fails before merge when a native runtime or packaged Electron path regresses on a qualified platform.

`.github/workflows/release.yml` runs on a `v*` tag or manual dispatch for an existing tag. It:

1. checks out the tagged revision;
2. verifies that `v<package.json version>` exactly matches the tag and that the tagged commit is contained in `origin/main`;
3. runs the full `pnpm check` release gate on Ubuntu and fresh-installed CLI workflow smoke on every native platform lane;
4. builds Linux x64, Windows x64, macOS Apple Silicon, and macOS Intel artifacts on matching native GitHub runners;
5. runs packaged CLI/SQLite/ripgrep/PTy/full-workflow smoke on each matching native runner and the Windows Job Object probe on Windows;
6. silently installs the produced Windows NSIS artifact and mounts/copies the produced macOS DMG, then reruns the same runtime smoke against the installed artifact;
7. packs the npm/CLI payload as `hostspan-<version>.tgz`;
8. refuses to overwrite an existing GitHub Release, then uploads the user-facing packages only after those installed-artifact gates pass;
9. generates `SHA256SUMS.txt`;
10. marks tags containing `-` as prereleases; `v0.4.0` is published as a stable release.

Create a release after the intended commit is on `main`:

```bash
git tag v0.4.0
git push origin v0.4.0
```

Do not move or reuse a published tag. The workflow also refuses to replace assets on an already-published release. Increment `package.json`, `src/version.ts`, and `docs/RELEASE.md` together before creating the next tag.

## Signing status

The current release workflow intentionally produces **unsigned** artifacts. Users may see Windows SmartScreen or macOS Gatekeeper warnings. Signing requires repository secrets and external certificates:

- Windows Authenticode certificate/token;
- Apple Developer ID Application certificate;
- Apple notarization credentials.

Signing credentials must never be committed to the repository. Add them as GitHub Actions secrets and keep unsigned local/package tests available so contributors without certificates can still verify packaging.

## Platform scope

Packaging and native-core support are separate claims:

| Environment | Current core status |
| --- | --- |
| Linux x64 / Ubuntu 24.04 | release-qualified core; Unix PTY + process groups |
| WSL2 | uses the Linux core; not native Windows qualification |
| Windows x64 | native core; ConPTY + Job Objects + private HostSpan DACL/state-path guard; full test/build, NSIS install, installed doctor/full smoke, packaged PTY lifecycle |
| macOS x64 | native core; full test/build, installed CLI doctor/full smoke, packaged PTY lifecycle, DMG/app runtime smoke |
| macOS arm64 | native core qualified on the matching GitHub macOS arm64 runner with the same core/package/runtime gate |

Packaging success must not be described as native-core security or process-recovery qualification.
