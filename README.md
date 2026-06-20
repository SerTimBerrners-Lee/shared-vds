# Shared VDS

Desktop shell for managing a user-prepared VDS reverse SSH workflow.

`shared-vds` is a separate Tauri v2 application built with React,
TypeScript, Rust, and Bun. The current snapshot is intentionally minimal and
contains the desktop window shell, local UI settings, app logging, generic
updater wiring, and a minimal reverse SSH tunnel manager for a user-prepared VDS.

## Статус

- Репозиторий публикуется отдельно от root workspace `shared-ai`.
- Target remote: `git@github.com:SerTimBerrners-Lee/shared-vds.git`.
- Legacy audio/transcription/model-loading code has been removed.
- Subscription, Shared VDS account auth, provider auth, and managed capacity UI
  have been removed from desktop.
- Current desktop flow is a server session helper: the user prepares the VDS,
  and the app can start/stop a local `ssh -N -R` reverse tunnel back to the
  user's local SSH.
- Stable release artifacts are published by GitHub Actions for macOS, Windows,
  and Linux.

## Роль в системе

Desktop сейчас отвечает за:

- локальное Tauri desktop приложение;
- минимальные локальные настройки: theme, interface language, autostart;
- generic app logging и updater surface;
- saved VDS connection fields and local reverse-tunnel fields;
- explicit start/stop of a local reverse SSH tunnel;
- ready-to-copy commands for entering the local project from the VDS.

Desktop сейчас не отвечает за:

- audio recording, STT, diarization, file transcription, call capture;
- local model downloads, Python runtimes, FFmpeg/STT sidecars;
- hotkey capture, paste automation, microphone/accessibility onboarding;
- device auth, token polling, subscription activation UI, provider auth;
- local OpenAI-compatible endpoint for Codex or `~/.codex/config.toml` patching;
- installing Claude, tmux, packages, or configuration on the VDS;
- billing, admin dashboard, provisioning, provider credentials;
- allocation rules, nodes, capacity и provisioning jobs.

Эти границы принадлежат будущим отдельным задачам и/или `shared-ai-web` /
`shared-ai-orchestrator`.

## Server Session Strategy v1

- Desktop не хранит provider credentials и не принимает решения о capacity.
- Пользователь сам готовит VDS, ставит Claude/tmux/пакеты и проходит provider
  login на сервере.
- Desktop хранит только параметры подключения: VDS host/port/user/key path,
  remote tunnel port, local SSH port и project path. Local user определяется
  автоматически из текущей OS session.
- Кнопка `Поднять туннель` запускает локальный `ssh -N -R`, чтобы на VDS адрес
  `127.0.0.1:<remoteTunnelPort>` вел на локальный SSH пользователя.
- На VDS пользователь сам выполняет команду входа обратно в локальный проект и
  запускает нужные инструменты.

## Стек

- Tauri v2
- React 19
- TypeScript
- Rust
- Bun

## Быстрый старт

Требования:

- Bun `1.2.x`
- Rust stable
- Tauri v2 system dependencies

Установка и запуск:

```bash
bun install
bun run tauri dev
```

Полезные проверки:

```bash
bunx tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
bun run check:versions
```

Сборка:

```bash
bun run tauri build
bun run build:release:macos
bun run build:release:windows
bun run build:release:linux
```

Логи разработки:

```bash
bun run logs
bun run logs:clear
```

## Build artifacts

Крупные generated artifacts не должны коммититься в repo:

- `node_modules/`
- `dist/`
- `target/`

## Структура

```text
src/                  React/TypeScript frontend
src/windows/settings/ Settings window and tabs
src/lib/              Store, i18n, theme, logger, updater
src-tauri/src/        Rust backend, settings window, logger
src-tauri/icons/      App icons
docs/                 Release review docs
scripts/              Release scripts
```

## Security

- Desktop currently stores only local UI settings.
- Do not add auth/token/provider credential storage without a separate security
  review.
- Bearer tokens, provider credentials, device tokens and lease secrets must not
  be logged if those surfaces are added later.
- Real provider accounts, public launch и публичная продажа pooled capacity
  требуют отдельного legal/provider approval checkpoint.

## Публикация

Этот repo публикуется как самостоятельный desktop project:

```bash
git remote add origin git@github.com:SerTimBerrners-Lee/shared-vds.git
git push -u origin main
```

Не превращайте root `shared-ai` workspace в monorepo и не переносите сюда
`shared-ai-web` или `shared-ai-orchestrator` код.

## License

Shared VDS is licensed under the [MIT License](LICENSE) (`MIT`).
