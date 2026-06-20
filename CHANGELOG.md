# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.6] - 2026-06-20

### Changed
- Reworked terminal discovery to keep `System` as the default option and expose
  only the strict per-platform picker matrix: Ghostty, Warp, and three popular
  terminals for macOS, Windows, and Linux.
- Added native best-effort launch paths for iTerm2, Alacritty, kitty, Git Bash,
  and Warp Tab Configs across supported platforms.

### Fixed
- Fixed updater metadata URLs to match GitHub release asset name normalization.
- Mapped legacy saved terminal preferences (`terminal`, `x-terminal-emulator`,
  `xterm`) back to `system`.

## [0.9.5] - 2026-06-20

### Changed
- Rotated the Tauri updater public key for the Shared VDS release channel.
- Configured the release workflow to use newly created updater signing secrets.

## [0.9.4] - 2026-06-20

### Added
- Added terminal preference persistence and backend terminal discovery for VDS
  SSH helper actions.

### Changed
- Switched the project license metadata and root license file to MIT.
- Restored the VDS availability timeline to 360 cells while keeping chart
  rendering limited to the optimized 120-sample window.
- Increased spacing between the VDS referral title and description.
- Initialized local Beads tracking instructions for the repo.

### Removed
- Removed legacy audio/transcription UI, floating widget, history, hotkey flow,
  permission onboarding, file/call capture, local model runtimes and sidecars.
- Removed cloud auth/device-token UI from the desktop shell.

### Changed
- Desktop app now starts as a minimal Tauri shell with local UI settings,
  logging and updater wiring.
- Release scripts no longer prepare STT/FFmpeg sidecars.

### Added
- `CHANGELOG.md` (this file)
