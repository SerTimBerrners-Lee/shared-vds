# Release Review v0.9.4

## Release

- Version: 0.9.4
- Release branch: release/v0.9.4
- Target tag: v0.9.4
- Reviewer: Codex
- Date: 2026-06-20

## Scope

- Key changes included in this release:
  - MIT license metadata and root `LICENSE`.
  - VDS availability timeline restored to 360 visual cells while charts stay on
    the optimized 120-sample history window.
  - VDS referral card spacing polish.
  - Terminal preference compile fix: store type/default, i18n keys, backend
    terminal discovery and optional terminal selection.
  - Local Beads tracking setup.
- User-facing changes:
  - More availability blocks in the VDS health timeline.
  - Better spacing in the VDS provider referral card.
  - Release is now published under MIT.
- Risky areas:
  - Terminal launcher selection touches both frontend and Rust Tauri commands.

## Checks run

- `bun run check:release`: passed
- `bun run build:release:macos`: app bundle built; full local command failed
  during DMG postprocess with `hdiutil: create failed - Device not configured`
- Native/GitHub Windows build: pending GitHub Actions
- Native/GitHub Linux build: pending GitHub Actions
- Additional manual checks:
  - `bunx tsc --noEmit`: passed
  - `cargo check --manifest-path src-tauri/Cargo.toml`: passed
  - `bun run check:versions`: passed
  - `SHARED_VDS_POSTPROCESS_MACOS_RELEASE=0 bun run build:release:macos`:
    passed

## Manual review

- Window open/close/minimize/maximize: not manually checked
- Theme switching: not manually checked
- Interface language switching: not manually checked
- Autostart switching: not manually checked
- Update prompt, if available: not manually checked
- README refreshed: license section updated

## Findings

- Blockers: none for tag publish
- Non-blocking issues:
  - Local DMG postprocess cannot complete in this macOS environment because
    `hdiutil` returns `Device not configured`; GitHub Actions remains the
    source of truth for final installer artifacts.
- Follow-ups after release: verify GitHub Actions assets and updater
  `latest.json` after tag publish.

## Decision

- Ready for `main` merge: yes
- Ready for tag publish: yes
