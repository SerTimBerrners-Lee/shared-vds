# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.7] - 2026-06-23

### Fixed
- Reverse and local SSH tunnels now stay alive in the background. A dedicated
  watchdog thread reaps dead `ssh` processes and restarts dropped tunnels on its
  own schedule, independent of whether the settings window is open or visible.
  Previously liveness checks and restarts only ran while the window polled, so a
  tunnel that dropped in the background only came back when the user reopened the
  app.
- Removed UI freezes and scroll stutter. Tunnel and system status commands used
  to perform blocking network I/O (local TCP probes and a remote SSH port check,
  up to several seconds) on the main thread on every poll. Status commands now
  return cached results computed by the watchdog, so the UI never blocks.
- Dropped `backdrop-filter` blur from scrollable surfaces and cards. The app
  background is opaque, so the blur was visually negligible but forced the macOS
  WebView to recomposite on every scroll frame.

### Changed
- Reverse/local SSH tunnels now use `TCPKeepAlive=yes` and a shorter
  `ServerAliveInterval` (15s) so dropped links are detected and restarted faster.
- The remote VDS port health probe is throttled to once per 30s and runs off the
  tunnels lock; `get_vds_system_status` no longer runs on the main thread.

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
