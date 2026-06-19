# Release Rule

This file defines the release workflow for Shared VDS.

## Naming

- Release branch: `release/vX.Y.Z`
- Release review file: `docs/release/review-vX.Y.Z.md`
- Git tag: `vX.Y.Z`

## Mandatory sequence

1. Collect all local changes and push them to the release branch first.
2. Update version numbers consistently in:
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
3. Refresh `README.md` before every release so documented behavior, supported
   platforms, commands, and release notes are current.
4. Run local release checks:
   - `bun run check:release`
   - `TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/shared-vds-updater.key bun run build:release:macos`
   - On native Windows/Linux runners, run `bun run build:release:windows` and
     `bun run build:release:linux` before claiming those artifacts are ready.
   - If the updater private key is password-protected, also set
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
5. Review the full release diff.
6. Write review results to `docs/release/review-vX.Y.Z.md`.
7. If blockers, risks, or recommendations need a decision, ask the user before
   merging to `main`.
8. Only after review is complete and questions are resolved, merge or push the
   approved changes to `main`.
9. Create and push the release tag `vX.Y.Z` from `main`.
10. Let GitHub Actions build and publish the release.

## Review checklist

- Working tree is clean and the release branch diff is intentional.
- README reflects the current product behavior and release process.
- Desktop auth, connector/cloud state, transcription flow and local runtime
  controls are still coherent.
- Short or noisy recordings do not paste obvious hallucinated text.
- `bun run check:release` passes.
- Local production build passes via `bun run build:release:macos`; Windows and
  Linux production builds pass on native runners or in GitHub Actions.
- Version numbers and release tag match.
- GitHub Actions release workflow matches the documented process.
- GitHub repository secrets include `TAURI_SIGNING_PRIVATE_KEY` and, if needed,
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- GitHub Release includes `latest.json`, macOS `.app.tar.gz`, Windows `.exe`,
  Linux `.AppImage`, and matching `.sig` files.

## GitHub Actions release source of truth

- Workflow file: `.github/workflows/release.yml`
- Tag push is the canonical release trigger.
- Updater metadata endpoint:
  `https://github.com/SerTimBerrners-Lee/shared-vds/releases/latest/download/latest.json`
- Build only platforms that are actually ready. Do not claim unsupported
  platforms in release notes.

## Output expectations

For each release, produce:

- release branch `release/vX.Y.Z`
- review file `docs/release/review-vX.Y.Z.md`
- updated `README.md`
- updated version files
- pushed `main`
- pushed tag `vX.Y.Z`
- GitHub Release artifacts created by Actions
