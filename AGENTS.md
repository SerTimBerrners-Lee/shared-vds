# shared-vds - AGENTS.md

## Язык и формат

- Всегда отвечай пользователю и документируй проект на русском языке, если
  пользователь явно не попросил другой язык.
- Технические имена, команды, пути, API, ошибки, логи и код оставляй в
  оригинальном виде.
- Файл проектных инструкций должен называться `AGENTS.md` uppercase.

## Статус проекта

`shared-vds` - отдельный desktop repo для Shared VDS.

Текущий snapshot намеренно зачищен от legacy Talkis audio/transcription
функциональности. В desktop больше не должно быть voice widget, file
transcription, call-capture, локальных STT runtimes, model download/install UI,
hotkey recording flow, microphone/accessibility onboarding или provider/API key
surfaces.

Текущий desktop v1 является менеджером серверной Claude-сессии: пользователь
сам готовит VDS, а приложение автоматизирует только локальное подключение по
SSH и reverse tunnel с VDS обратно на локальный SSH пользователя.

Если потребуется новая продуктовая функция, добавляй ее отдельной задачей и не
возвращай legacy audio/transcription pipeline без прямого запроса пользователя.

## Роль в системе

Desktop сейчас отвечает за:

- Tauri v2 + React + TypeScript + Rust desktop shell.
- Минимальные локальные настройки UI: theme, interface language, autostart.
- Generic app logging и updater surface.
- Настройки уже подготовленного VDS: host, SSH port, user, SSH key path.
- Настройки обратного доступа к локальной машине: remote tunnel port на VDS,
  local SSH port и project path. Локальный пользователь определяется
  автоматически из текущей macOS/OS session.
- Явный запуск/остановку локального процесса `ssh -N -R`, который открывает на
  VDS `127.0.0.1:<remoteTunnelPort>` и ведет его на локальный
  `127.0.0.1:<localSshPort>`.
- Отображение готовых команд, которые пользователь может выполнить на VDS для
  входа обратно в локальный проект. Конкретные инструменты пользователь
  запускает сам.

Desktop сейчас не отвечает за:

- audio recording, speech-to-text, diarization, file transcription, call capture;
- local STT sidecars, Python runtimes, FFmpeg sidecars, model downloads;
- hotkey capture или paste automation;
- subscription management и billing;
- Shared VDS account auth, device auth и provider auth;
- локальный OpenAI-compatible endpoint для Codex;
- patch `~/.codex/config.toml`;
- admin dashboard;
- VDS/IP/provider account provisioning;
- установку Claude, tmux, пакетов или конфигурации на VDS;
- provider credentials;
- allocation rules, nodes, capacity и provisioning jobs.

Эти границы принадлежат будущим отдельным задачам и/или `shared-ai-web` /
`shared-ai-orchestrator`.

## Инструменты

- Использовать Bun как основной JavaScript runtime, package manager и script
  runner.
- Использовать `bun`, `bun run <script>` и `bunx`.
- Не добавлять `npm`, `yarn` или `pnpm` workflow без отдельного решения.
- Коммитить `bun.lock`.
- Не добавлять `package-lock.json`, `yarn.lock` или `pnpm-lock.yaml`.

## Команды

```bash
bun install
bun run tauri dev
```

Проверки:

```bash
bunx tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
bun run check:versions
```

Сборка:

```bash
bun run tauri build
bun run build:release:macos
```

Логи:

```bash
bun run logs
bun run logs:clear
```

## Project structure

```text
src/                  React/TypeScript frontend
src/windows/settings/ Settings window and tabs
src/lib/              Store, i18n, theme, logger, updater
src-tauri/src/        Rust backend, settings window, logger
src-tauri/icons/      App icons
docs/                 Release notes and review docs
scripts/              Release scripts
```

## Security

- Не логировать bearer tokens, provider credentials, device tokens, lease
  secrets или API keys.
- Не хранить provider credentials, bearer tokens, device tokens или cookies.
- Не логировать содержимое SSH private key; допустимо хранить только путь к
  ключу, если пользователь сам его указал.
- `~/.codex/config.toml` не менять в текущей модели.
- Reverse tunnel можно запускать только по явному действию пользователя.
- Real provider accounts, public launch и публичная продажа pooled capacity
  требуют отдельного legal/provider approval checkpoint.

## Что не делать без отдельного запроса

- Не добавлять web/admin/billing код в desktop repo.
- Не переносить сюда `shared-ai-web` или `shared-ai-orchestrator`.
- Не выполнять реальные SSH/VDS/provider операции.
- Не устанавливать и не настраивать софт на VDS: пользователь делает это сам.
- Не редактировать чужие Codex CLI/app конфиги.
- Не превращать repo в monorepo.
- Не возвращать legacy Talkis audio/transcription/model-loading code.


<!-- BEGIN BEADS INTEGRATION v:1 profile:local -->
## Трекинг задач через bd (beads)

- Для локального issue tracking используй `bd`.
- Перед поиском новой работы проверяй `bd ready` или `bd status`.
- Для новых задач используй `bd create`; для обновления статуса - `bd update`;
  для закрытия - `bd close`.
- Не создавай markdown TODO/task-list как параллельную систему трекинга, если
  это не отдельный пользовательский запрос.
- Не выполняй `git push`, `bd dolt push`, deploy или внешнюю синхронизацию без
  явного запроса пользователя.

<!-- END BEADS INTEGRATION -->
