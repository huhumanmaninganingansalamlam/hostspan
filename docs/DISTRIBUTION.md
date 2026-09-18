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

The packaged Electron executable can also run the HostSpan CLI through `ELECTRON_RUN_AS_NODE=1`; this is how the packaged tray starts/stops the durable daemon without requiring a second embedded runtime.

After creating an unpacked or distributable package, verify the package rather than only the source tree:

```bash
pnpm desktop:smoke
```

The smoke script executes `dist/src/cli/index.js` from inside the packaged ASAR, checks the packaged version, loads the packaged `better-sqlite3` native module in an in-memory database, and runs a minimal packaged CLI/config round trip.

## Continuous integration

`.github/workflows/ci.yml` runs the complete code gate and then packages Linux desktop artifacts. A pull request fails if the Electron application can no longer be packaged.

`.github/workflows/release.yml` runs on a `v*` tag or manual dispatch for an existing tag. It:

1. checks out the tagged revision;
2. verifies that `v<package.json version>` exactly matches the tag;
3. runs the full `pnpm check` release gate on Ubuntu;
4. builds Linux x64, Windows x64, macOS Apple Silicon, and macOS Intel artifacts on matching native GitHub runners;
5. runs the packaged CLI/native-SQLite smoke on every desktop runner;
6. packs the npm/CLI payload as `hostspan-<version>.tgz`;
7. uploads the user-facing packages to one GitHub Release;
8. generates `SHA256SUMS.txt`;
9. marks tags containing `-` (for example, `v0.2.0-alpha.17`) as prereleases.

Create a release after the intended commit is on `main`:

```bash
git tag v0.2.0-alpha.17
git push origin v0.2.0-alpha.17
```

Do not move or reuse a published tag. Increment `package.json`, `src/version.ts`, and `docs/RELEASE.md` together before creating the next tag.

## Signing status

The current alpha workflow intentionally produces **unsigned** artifacts. Users may see Windows SmartScreen or macOS Gatekeeper warnings. Production signing requires repository secrets and external certificates:

- Windows Authenticode certificate/token;
- Apple Developer ID Application certificate;
- Apple notarization credentials.

Signing credentials must never be committed to the repository. Add them as GitHub Actions secrets and keep unsigned local/package tests available so contributors without certificates can still verify packaging.

## Platform scope

The Linux/WSL2 HostSpan core is release-qualified. Windows uses the WSL2 HostSpan core through the native tray shell. macOS and native Windows process-provider qualification remain separate from merely producing an Electron installer. Packaging success must not be described as native-core security or process-recovery qualification.
