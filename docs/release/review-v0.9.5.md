# Release Review v0.9.5

## Release

- Version: 0.9.5
- Release branch: release/v0.9.5
- Target tag: v0.9.5
- Reviewer: Codex
- Date: 2026-06-20

## Scope

- Key changes included in this release:
  - Rotated the Tauri updater public key for the Shared VDS release channel.
  - Added matching `TAURI_SIGNING_PRIVATE_KEY` and
    `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub repository secrets.
  - Bumped release version from `0.9.4` to `0.9.5`.
- User-facing changes:
  - New installs from this version include the updater public key that matches
    the configured release signing secrets.
- Risky areas:
  - Existing `v0.9.4` builds cannot validate the new updater key because they
    were shipped with the previous public key and no updater metadata.

## Checks run

- `bun run check:release`: passed
- `bunx tsc --noEmit`: passed
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed
- `bun run check:versions`: passed
- `git diff --check`: passed
- `bunx tauri signer sign -f ~/.tauri/shared-vds-updater.key --password <local password> /tmp/shared-vds-updater-sign-test.txt`: passed
- `SHARED_VDS_POSTPROCESS_MACOS_RELEASE=0 TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/shared-vds-updater.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<local password> bun run build:release:macos`: passed

## Manual review

- README refreshed: no version-specific update needed
- GitHub secrets configured:
  - `TAURI_SIGNING_PRIVATE_KEY`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- Local macOS updater archive signature created:
  - `src-tauri/target/release/bundle/macos/Shared VDS.app.tar.gz.sig`

## Findings

- Blockers: none for tag publish
- Non-blocking issues:
  - `v0.9.4` remains a manual-download release for updater purposes because it
    was already built without `latest.json` and with the previous public key.
- Follow-ups after release: verify GitHub Actions assets include `latest.json`
  and matching `.sig` files.

## Decision

- Ready for `main` merge: yes
- Ready for tag publish: yes
