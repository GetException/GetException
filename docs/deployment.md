# Установка и обновление GetException

В репозитории подготовлен процесс выпуска и установки. Сам сервер и настройки GitHub подключаются отдельно. Локальная установка `yarn local:start` продолжает использовать `runtime/local` и не участвует в production deploy.

## Что происходит после push

1. Pull request в `stable` проходит `Checks`: `yarn checks` (включая Linux Docker тест установки) и аудит зависимостей.
2. Push в `stable` запускает `Prepare release`. Он повторяет проверки, поднимает patch-версию обоих SDK командой Yarn, выполняет `yarn checks` перед release commit и отправляет commit с `[skip ci]`.
3. `Prepare release` запускает `Release` через `workflow_dispatch` на этом commit. Это отдельный запуск, чтобы подписи артефактов содержали именно SHA выпущенного кода. Повторная попытка переиспользует уже подготовленный release commit. Если `stable` ушла вперёд, старый код не публикуется.
4. `Release` собирает Linux amd64 образы web, ingest, worker, mail и migrate, публикует их в GHCR с SHA и `stable`, формирует SBOM и provenance. Критические уязвимости образа блокируют продолжение. Существующий SHA-образ переиспользуется.
5. Публикуются отсутствующие версии `@getexception/browser` и `@getexception/react` с npm provenance. Уже существующая версия должна совпадать с собранным пакетом. `NPM_TOKEN` получает только шаг публикации.
6. В GitHub Releases появляется prerelease `deploy-<полный SHA>` с установщиком, bundle, checksums и attestations. Прежние артефакты не перезаписываются.
7. CI скачивает опубликованные npm tarballs и собирает из них отдельные browser/React fixtures. Другой job скачивает опубликованный установщик, проверяет его attestation и устанавливает временную копию приложения. Тест создаёт Owner с TOTP, проект, отправляет ошибки, проверяет UI, обновление, откат и сохранение сессии/данных. После успеха prerelease становится обычным release.
8. Если `DEPLOY_ENABLED=true`, после approval environment `production` CI по SSH запускает обновление существующей установки и проверяет приём события. Пока переменная не включена, SSH job пропускается.

Тег `stable` у Docker-образа служит указателем для человека. Установщик запускает точные digest из проверенного `release.json`. Обновление никогда не выбирает плавающий тег.

## Настройки GitHub перед первым выпуском

Репозиторий: `GetException/GetException`. Установщик рассчитан на публичные GitHub Releases и публичные GHCR packages. После первого создания packages проверьте их visibility и связь с этим репозиторием.

В настройках репозитория:

- Основная ветка `stable`; разрешены GitHub Actions и `workflow_dispatch`.
- Ruleset для `stable`: review, обязательный `Checks / checks`, запрет force push и удаления ветки. Точные названия status checks появляются после первого запуска.
- Создайте команду `GetException/maintainers` с write access либо замените её в `.github/CODEOWNERS` реальной командой. Включите обязательный review владельцев кода.
- Создайте environment `release` с независимым approval. Добавьте в него `NPM_TOKEN` с правом публикации только двух SDK. Разрешите GitHub Actions публиковать в npm от имени владельца scope `@getexception`.
- Для защищённой `stable` задайте repository secret `RELEASE_TOKEN`: fine-grained token отдельного release-оператора с `Contents: write` и `Actions: write`. Его актор должен иметь разрешённый ruleset bypass только для автоматического release commit. Без токена workflow использует `GITHUB_TOKEN`, который обычно не может обойти защиту ветки. Обычные изменения проходят PR/review.
- Создайте environment `production` с обязательным approval и разрешением только для `stable`. Параллельные выпуски сериализованы через workflow concurrency, на сервере действует дополнительный lock.

Доступ к серверу пока не нужен. Эти параметры добавляются на следующем этапе:

| Тип                 | Имя                  | Назначение                                                                        |
| ------------------- | -------------------- | --------------------------------------------------------------------------------- |
| Repository variable | `DEPLOY_ENABLED`     | Оставить пустой до первой установки; затем `true`                                 |
| Production variable | `DEPLOY_HOST`        | SSH hostname или IPv4 сервера                                                     |
| Production variable | `DEPLOY_USER`        | Пользователь, которому принадлежат установка и Docker доступ                      |
| Production variable | `DEPLOY_PORT`        | По умолчанию `22`                                                                 |
| Production variable | `DEPLOY_DIR`         | По умолчанию `/opt/getexception`                                                  |
| Production secret   | `DEPLOY_SSH_KEY`     | Отдельный приватный ключ deploy-пользователя                                      |
| Production secret   | `DEPLOY_KNOWN_HOSTS` | Проверенная запись host key сервера; fingerprint сверяется по независимому каналу |

SSH использует строгую проверку host key. CI не выполняет `ssh-keyscan` с автоматическим доверием и не создаёт новый Owner на сервере.

## Подготовка сервера

Поддерживается Linux amd64 с Docker Engine, Compose 2.24+, Python 3.9+, Bash, curl и актуальным GitHub CLI с `gh attestation verify`. Node/Yarn и исходники на сервере не нужны. Установщик проверяет prerequisites и не устанавливает Docker за оператора.

Для прототипа предусмотрите около 8 ГБ RAM, место для PostgreSQL, нескольких версий образов и backup. Назначьте два DNS имени серверу, например `monitor.example.com` и `ingest.monitor.example.com`. Порты 80/443 должны быть доступны Caddy. На сервере с уже работающим reverse proxy сначала согласуйте схему портов; этот Compose занимает 80/443.

Один deploy-пользователь должен иметь доступ к Docker и запись в каталог установки. Например, оператор заранее создаёт `/opt/getexception` с владельцем этим пользователем и правами `0700`. Последующие команды выполняются от того же пользователя. Настройте `gh auth login` с минимальным доступом для проверки публичных attestations. SMTP настраивается на существующий почтовый сервис с TLS или STARTTLS; тестовая почта в production не запускается.

## Первая установка

Выберите полный SHA **завершённого** GitHub Release. Один раз задайте переменные `ACME_EMAIL`, `SMTP_HOST`, `SMTP_FROM`, `SMTP_PORT` (`587`), `SMTP_MODE` (`starttls` либо `tls`), при необходимости `SMTP_USER` и `SMTP_PASSWORD`. Пароль удобно ввести через `read -rs SMTP_PASSWORD` и затем `export SMTP_PASSWORD`, чтобы он не оказался в истории shell. Переменные должны быть доступны процессу установщика.

Можно скачать, проверить и запустить установщик одной составной командой (вместо `RELEASE_SHA` подставляется полный SHA):

```bash
release=RELEASE_SHA; base="https://github.com/GetException/GetException/releases/download/deploy-$release"; curl -fLsS --proto '=https' --proto-redir '=https' "$base/install-getexception.sh" -o install-getexception.sh && curl -fLsS --proto '=https' --proto-redir '=https' "$base/install-getexception.sh.sha256" -o install-getexception.sh.sha256 && sha256sum --check install-getexception.sh.sha256 && gh attestation verify install-getexception.sh --repo GetException/GetException --signer-workflow GetException/GetException/.github/workflows/release.yml --source-ref refs/heads/stable --source-digest "$release" && bash install-getexception.sh --release "$release" --dashboard-host monitor.example.com --ingest-host ingest.monitor.example.com
```

Те же действия можно выполнить по очереди: скачать оба файла, проверить checksum, проверить attestation и только затем выполнить `bash install-getexception.sh ...`. Сам bootstrap дополнительно проверяет controller, а controller — checksum, attestation и содержимое архива. `--archive-url` позволяет указать другое HTTPS размещение bundle и соседнего `.sha256`; проверка identity и подписей остаётся обязательной.

Параметры `--install-dir /другой/каталог` и `--skip-start` поддерживаются. `--skip-start` скачивает проверенные файлы и создаёт конфигурацию, но не меняет работающую версию. Для запуска после подготовки повторите установку без `--skip-start`.

После установки:

1. Откройте `https://monitor.example.com/setup`.
2. Прочитайте setup token из `/opt/getexception/runtime/setup-token` на сервере. Он не выводится в CI/log и не включается в URL. Срок первоначального токена — 24 часа с первой миграции; проходите setup сразу после установки.
3. Создайте Owner, подключите аутентификатор и сохраните recovery codes. Installation domain — hostname кабинета, уже указанный установщику.
4. Создайте проект, подключите SDK и проверьте приглашение на существующую почту.

Owner создаётся один раз. Повторная установка, обновление и перезапуск сохраняют его пароль, MFA, участников и данные. Установщик не обновляет значения уже существующего `.env`, даже если новые environment variables отличаются. Он удаляет локальную копию setup token при последующем успешном обновлении уже настроенной установки; в БД токен погашается сразу при регистрации.

## Обновление одной командой

```bash
/opt/getexception/getexception update --release FULL_RELEASE_SHA
```

Команда проверяет и скачивает релиз, валидирует Compose/Caddy, скачивает образы, создаёт согласованный backup, останавливает приложения, применяет миграции и запускает сервисы. Затем проверяет readiness, HTTPS и разделение origins. Это обновление с коротким перерывом обслуживания.

Для проверки полного пути приёма ошибок создайте отдельный проект `GetException deployment probe`. Добавьте его DSN и разрешённый origin в `runtime/.env` как `SMOKE_DSN="..."` и `SMOKE_ORIGIN="https://monitor.example.com"`. DSN должен вести на ingest domain этой установки. Разрешённый origin нужно также указать в настройках probe-проекта.

```bash
/opt/getexception/getexception update --release FULL_RELEASE_SHA --require-ingestion-smoke
```

Такую команду выполняет CI. Она отправляет одно техническое событие в probe-проект и ждёт его обработки worker. Если проверка не проходит, обновление считается неудачным и выполняется совместимый откат. Первую настройку probe-проекта делаем после создания Owner, перед включением `DEPLOY_ENABLED`.

Остальные команды:

```bash
/opt/getexception/getexception status
/opt/getexception/getexception smoke
/opt/getexception/getexception backup
/opt/getexception/getexception rollback
```

`rollback` возвращает предыдущие файлы и образы, сохраняя текущую базу. Обратные SQL-миграции автоматически не выполняются. Разрешение на совместимый откат хранится в `deploy/release-policy.json`; при изменении runtime schema разработчик обязан обновить его и проверить прошлую версию приложения на новой схеме.

## Что хранится на сервере

```text
/opt/getexception/
  getexception                 # команда управления
  current -> releases/<SHA>    # активный релиз
  releases/<SHA>/              # проверенные файлы релиза без исходников и dev fixtures
  runtime/
    .env                      # секреты и домены; 0600
    setup-token               # только для первоначальной настройки
    state.json                # текущий и предыдущий SHA
    pending.json              # существует только во время незавершённой операции
    backups/*.dump            # согласованные backup перед обновлением
```

PostgreSQL и Caddy используют именованные Docker volumes с постоянным Compose project name `getexception`. Нельзя менять project name, выполнять `down --volumes` или удалять `runtime` для обычного обновления. В релизном архиве нет source-map storage: загрузка и symbolication карт ещё не реализованы в MVP.

В `.env` используется формат `KEY="value"` с JSON escaping и `$$` для буквального `$`, совместимый с Compose. Installer не выполняет этот файл как shell-код. Изменять домены уже настроенного workspace одной заменой env нельзя: домен также закреплён в БД. Такая миграция требует отдельной процедуры.

## Сбой и восстановление

- При ошибке до миграции активная версия остаётся прежней. При неготовности новой версии controller возвращает совместимую предыдущую и завершает команду с ошибкой, чтобы CI не показывал успешный deploy.
- При ошибке миграции или аварийном прерывании сохраняется `runtime/pending.json`; новый update блокируется. Приложения после начала миграции остаются остановлены. Сначала сохраните журнал, проверьте состояние `_prisma_migrations`, backup и контейнеров. Не удаляйте журнал вслепую и не запускайте миграцию параллельно.
- Для восстановления после завершённой совместимой миграции оператор проверяет совместимость предыдущего SHA, запускает его сервисы и health checks, согласует `current` и `state.json`, затем архивирует `pending.json`. Если миграция завершилась ошибкой, восстановите backup в **отдельную** базу либо разберите SQL и примените документированный `prisma migrate resolve`; автоматического решения для произвольной сломанной миграции нет.
- Локальный `.dump` можно проверить через `pg_restore --list`, а процедуру восстановления — через `pg_restore` в отдельный PostgreSQL. CI восстанавливает backup в отдельную пустую базу и сверяет данные. Перед реальным использованием необходимо выполнить restore drill и настроить внешние резервные копии.
- `.dump` не содержит ключей шифрования. Отдельно сохраняйте `runtime/.env` в защищённое внешнее хранилище. Без старого `TOTP_ENCRYPTION_KEY` невозможно расшифровать существующий MFA; без `MAIL_ENCRYPTION_KEY` невозможно обработать старые зашифрованные письма.
- Старые releases, образы и backups автоматически не удаляются. Удалять их можно после проверки retention политики и доступного пути отката. Установщик не запускает `docker system prune`.

## Проверки и границы готовности

```bash
nvm use
yarn install --immutable
yarn ci:tools
yarn local:mailpit
yarn checks
```

`ci:tools` один раз скачивает actionlint и gitleaks с закреплёнными SHA256. `yarn checks` включает unit-тесты установщика, проверку workflow, license/secret checks, прежние проверки приложения и PostgreSQL integration tests. На Linux `yarn checks` также выполняет `yarn test:compose`: реальный Docker build/start, update/rollback и restore. Release jobs отдельно проверяют registry и уязвимости образов. Отсутствие Docker в CI считается ошибкой.

Здесь готовится процесс для существующего прототипа. Source maps, S3 backups, внешний rate limiter/WAF и нагрузочные SLO не становятся реализованными от появления workflow; они остаются в [плане](./next-iteration.md). Публичный TLS/SMTP, host firewall, дисковое шифрование и реальные GitHub permissions проверяются при подключении сервера. Подписи и npm provenance можно окончательно проверить только на первом опубликованном релизе.

Механика основана на официальных интерфейсах [Compose `up --wait`](https://docs.docker.com/reference/cli/docker/compose/up/), [GitHub attestation verification](https://cli.github.com/manual/gh_attestation_verify) и [Yarn npm publish с provenance](https://yarnpkg.com/cli/npm/publish).
