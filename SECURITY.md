# Security policy

PicToWebP is a local, offline image converter. The converter itself makes no
network calls, emits no telemetry, and stores nothing between runs.

## Reporting a vulnerability

Open a private security advisory on GitHub:
<https://github.com/aditya-xq/PicToWebP/security/advisories/new>

Please include the affected edition (`rust`, `python`, or `web`), version, and
a minimal reproduction. Do not open a public issue for an exploitable problem.

## Release integrity

- Rust binaries are built from tagged commits (`rust-vX.Y.Z`) in GitHub Actions.
- Every release publishes `SHA256SUMS`, a `latest.json` manifest, and Sigstore
  attestations for the archives, the raw binaries, and the manifest itself.
  Verify the manifest before trusting its checksums:
  ```bash
  gh attestation verify latest.json --repo aditya-xq/PicToWebP
  gh attestation verify pictowebp --repo aditya-xq/PicToWebP
  ```
- Installers verify the checksum from the manifest before moving a binary into
  place, and fail closed on a mismatch. `--require-attestation` makes the
  manifest and archive attestation checks mandatory.
- `--uninstall` refuses to remove a directory that does not contain
  `install.json`, so a path typo cannot delete unrelated data.
- `install.json` is a local marker, not a signature; do not treat it as proof
  of binary integrity.
- Configure a repository ruleset so only maintainers can create `rust-v*`
  tags. The release workflow additionally refuses tags whose commit is not
  reachable from `main`.

## Installer network access

The **installer** downloads a release from GitHub once. The **converter**
never touches the network. `pictowebp --info` is local-only and safe to run in
an offline or privacy-sensitive environment.

## Resource limits

- Decoded images are capped at 500,000,000 pixels (`--max-pixels` or
  `PICTOWEBP_MAX_PIXELS`); oversized inputs are skipped with the
  `Image too large` category instead of being allocated. Images above 100 MP
  are converted sequentially to bound peak memory.
- `--threads` is capped at 256 in both editions.
- JSON failure lists are capped at 100 entries; the full list stays in the
  report file.

## Supported versions

Only the latest minor release of each edition receives security fixes.
