# Release Review v0.9.6

## Release

- Version: 0.9.6
- Release branch: `release/v0.9.6`
- Target tag: `v0.9.6`
- Reviewer: Codex
- Date: 2026-06-20

## Scope

- Key changes included in this release:
  - strict per-platform terminal picker matrix with `System` as the default;
  - native best-effort terminal launch paths for Ghostty, Warp, iTerm2,
    Alacritty, kitty, Windows Terminal, PowerShell, Git Bash, GNOME Terminal,
    Konsole and Xfce Terminal;
  - legacy terminal preference mapping back to `system`;
  - updater metadata URL fix already present on `main`.
- User-facing changes:
  - the terminal dropdown is hidden when only `System` is available;
  - macOS `Terminal`, Linux `x-terminal-emulator`, and `xterm` are no longer
    exposed as separate picker options.
- Risky areas:
  - terminal launch command differences across OSes;
  - Warp Tab Config file locations and URI launch behavior;
  - GitHub Actions signing/secrets for release artifacts.

## Checks run

- `bun run check:release`: passed
- `TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/shared-vds-updater.key bun run build:release:macos`: passed locally for macOS app/DMG; updater artifacts were disabled because the local signing key/password pair was not available.
- Native/GitHub Windows build: GitHub Actions after tag push
- Native/GitHub Linux build: GitHub Actions after tag push
- Additional manual checks:
  - `bun test ./src/lib/terminalPicker.test.ts`: passed
  - `cargo test --manifest-path src-tauri/Cargo.toml terminal_launch_candidates_keep_expected_order`: passed
  - `cargo test --manifest-path src-tauri/Cargo.toml terminal_id_deserializes_legacy_preferences_as_system`: passed
  - `git diff --check`: passed

## Manual review

- Window open/close/minimize/maximize: not manually exercised in this release.
- Theme switching: not manually exercised in this release.
- Interface language switching: not manually exercised in this release.
- Autostart switching: not manually exercised in this release.
- Update prompt, if available: not manually exercised in this release.
- README refreshed: yes.

## Findings

- Blockers: none found before local checks.
- Non-blocking issues:
  - local Windows/Linux native bundles are expected to be produced by GitHub
    Actions, not this macOS machine;
  - local macOS build did not produce updater signatures because local updater
    signing credentials were not available. Release signing is expected to run
    in GitHub Actions from repository secrets.
- Follow-ups after release:
  - verify GitHub release assets and `latest.json` after Actions complete.

## Decision

- Ready for `main` merge: yes.
- Ready for tag publish: yes.
