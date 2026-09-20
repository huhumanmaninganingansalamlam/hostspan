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

On Linux and macOS, the packaged Electron executable can also run the HostSpan CLI through `ELECTRON_RUN_AS_NODE=1`; this is how the packaged tray starts/stops the durable daemon without requiring a second embedded runtime. On Windows, the tray intentionally delegates HostSpan core operations to the WSL2 `hostspan` CLI instead of claiming a native Windows core.

After creating an unpacked or distributable package, verify the package rather than only the source tree:

```bash
pnpm desktop:smoke
```

On Linux and macOS, the smoke script executes `dist/src/cli/index.js` from inside the packaged ASAR, checks the packaged version, loads the packaged `better-sqlite3` native module in an in-memory database, and runs a minimal packaged CLI/config round trip. On Windows, where the desktop shell delegates the core to WSL2, the smoke is intentionally static: it verifies the packaged PE executable, ASAR CLI/desktop/icon payloads, and unpacked Windows `better-sqlite3` binding without executing the desktop binary as a native HostSpan core.

The Windows package-layout smoke can also be reproduced from Linux before tagging:

```bash
rm -rf out-win-cross
pnpm exec electron-builder --config electron-builder.yml --win dir --x64 --config.directories.output=out-win-cross
node scripts/smoke-packaged-cli.mjs --platform win32 --arch x64 --out-dir out-win-cross
rm -rf out-win-cross
```

The `--platform`, `--arch`, and `--out-dir` overrides are for static package validation. Executable CLI/native-SQLite smoke remains restricted to a matching Linux/macOS host runtime.

## Continuous integration

`.github/workflows/ci.yml` runs the complete code gate and then packages Linux desktop artifacts. A pull request fails if the Electron application can no longer be packaged.

`.github/workflows/release.yml` runs on a `v*` tag or manual dispatch for an existing tag. It:

1. checks out the tagged revision;
2. verifies that `v<package.json version>` exactly matches the tag;
3. runs the full `pnpm check` release gate on Ubuntu;
4. builds Linux x64, Windows x64, macOS Apple Silicon, and macOS Intel artifacts on matching native GitHub runners;
5. runs the full packaged CLI/native-SQLite smoke on Linux/macOS and the product-aligned package/runtime smoke on Windows;
6. packs the npm/CLI payload as `hostspan-<version>.tgz`;
7. uploads the user-facing packages to one GitHub Release;
8. generates `SHA256SUMS.txt`;
9. marks tags containing `-` (for example, `v0.2.0-alpha.21`) as prereleases.

Create a release after the intended commit is on `main`:

```bash
git tag v0.2.0-alpha.21
git push origin v0.2.0-alpha.21
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
| Linux x64 / Ubuntu 24.04 | release-qualified Alpha core |
| WSL2 | uses the Linux core; not native Windows support |
| Windows x64 installer | packaged native tray shell that delegates current core operations to WSL2; not native Windows core qualification |
| macOS arm64/x64 package | package/runtime preview; complete core qualification is still separate |

The next implementation milestone removes tmux from the Unix terminal architecture. Linux must pass the full HostSpan-owned PTY session/recovery gate without tmux. macOS will run the same native PTY terminal-contract suite, but that result alone does not qualify the complete macOS file/process/security core. Native Windows remains a later ConPTY + Job Object milestone and WSL2 evidence will not be used as a substitute.

Packaging success must not be described as native-core security or process-recovery qualification.
