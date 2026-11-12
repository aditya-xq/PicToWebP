# Installing and verifying

Prebuilt binaries come from GitHub Releases. No Rust toolchain, no admin
rights, no `PATH` edits.

## Defaults

| OS | Directory | Binary |
|----|-----------|--------|
| Windows | `%LOCALAPPDATA%\Programs\pictowebp` | `pictowebp.exe` |
| macOS / Linux | `~/.local/bin` | `pictowebp` |

On ARM64 Windows a native build is published; releases without one fall back
to the x64 binary with a warning (it runs under emulation). Linux ARM64 uses the
static musl asset, so it runs on any distribution regardless of glibc version.

Override with `--install-dir` / `-InstallDir` or `$PICTOWEBP_INSTALL_DIR`.

## Options

Both scripts accept the same options.

| Option | Behaviour |
|--------|-----------|
| `--version X.Y.Z` | Install a specific release. |
| `--install-dir DIR` | Destination directory. |
| `--asset-url URL` | Explicit archive (mirror or air-gapped). |
| `--sha256 HASH` | Expected checksum for `--asset-url` / `--from-file`. |
| `--from-file PATH` | Install a local binary without downloading. |
| `--dry-run` | Print the plan; write nothing. |
| `--verify-only` | Verify the installed binary (or the `--from-file` path) against the release checksum. |
| `--uninstall` | Remove the install directory. |
| `--json` | One JSON object on stdout. |
| `--skip-attestation` | Do not call `gh attestation verify`. |
| `--require-attestation` | Fail unless `gh` verifies the manifest and archive. Requires `gh` 2.49 or newer. |

## Verify

```bash
pictowebp --info --json
```

Compare the printed version with the manifest. For supply-chain checks:

```bash
gh attestation verify pictowebp --repo aditya-xq/PicToWebP
```

Installers verify the SHA-256 from the release manifest first and fail closed
on a mismatch. When `gh` is available they also verify the manifest and the
archive with Sigstore; `--require-attestation` makes both mandatory. The
manifest they write records `"verified": true` only when a checksum or
attestation was actually checked. An explicit `--asset-url` (or a
`--from-file` binary) without `--sha256` still installs, but prints a warning
and records `"verified": false`; treat that as an unverified install.

## Offline / air-gapped

1. Download the archive and `SHA256SUMS` on a connected machine.
2. Transfer both.
3. Install from the local file:

```bash
sh install.sh --from-file ./pictowebp --sha256 <hash>
```

```powershell
.\install.ps1 -FromFile .\pictowebp.exe -Sha256 <hash>
```

## CI

```bash
sh install.sh --version 0.4.0 --install-dir ./.tools --json
./.tools/pictowebp ./assets --json --out ./dist/img --fail-on-error
```

Pin the version in CI. Use `latest` only for interactive setups.

## Upgrade policy

The skill must not upgrade on its own. Upgrade when the user asks, or when a
required capability is missing from `--info --json`.

## Uninstall

```bash
sh install.sh --uninstall
```

```powershell
.\install.ps1 -Uninstall
```

Uninstall only removes a directory that contains `install.json`; a trailing
slash, the home directory, a drive root, or a path typo is refused.

For a pinned, immutable installer URL (recommended for CI and regulated
environments), download `install.sh` / `install.ps1` from the versioned
release asset instead of the Pages site, and add `--require-attestation`:

```bash
curl -fsSLO https://github.com/aditya-xq/PicToWebP/releases/download/rust-v0.4.0/install.sh
sh install.sh --version 0.4.0 --require-attestation --json
```

`install.json` is a local marker, not a signature. `--require-attestation`
needs a release-built binary; a locally compiled binary has no attestation and
will be rejected.
