# Установка и обновление GetException

В репозитории подготовлен процесс выпуска и установки. Сам сервер и настройки GitHub подключаются отдельно. Локальная установка `yarn local:start` продолжает использовать `runtime/local` и не участвует в production deploy.

## Что происходит после push

1. Pull request в `stable` проходит `Checks`: `yarn checks` (включая Linux Docker тест установки) и аудит зависимостей.
2. Push в `stable` запускает серверный `Release` на исходном SHA. Версии SDK не меняются; `NPM_TOKEN` не требуется. Проверка remote `stable` останавливает выпуск устаревшего commit. Для повторной попытки можно вручную запустить `Release` на `stable`, при необходимости указав точный SHA.
3. После `yarn checks` собираются Linux amd64 образы web, ingest, worker, mail и migrate; они публикуются в GHCR с SHA и `stable`, SBOM и provenance. Критические уязвимости образов блокируют продолжение. Существующий SHA-образ переиспользуется; отчёты Grype сохраняются в artifacts даже при отказе проверки.
4. В GitHub Releases появляется prerelease `deploy-<полный SHA>` с установщиком, bundle, checksums и attestations. Прежние артефакты не перезаписываются.
5. CI собирает browser/React fixtures из этого же checkout, скачивает опубликованный установщик, проверяет attestation и устанавливает временную копию приложения. Тест создаёт Owner с TOTP, проект, отправляет ошибки, проверяет UI, обновление, откат, восстановление backup и сохранение сессии/данных. После успеха prerelease становится обычным release.
6. Если `DEPLOY_ENABLED=true`, после approval environment `production` CI по SSH обновляет существующую установку и проверяет приём события. Пока переменная не включена, SSH job пропускается.

SDK остаются в исходниках и проходят контрактные/alias-тесты. Публичные npm-пакеты для серверного релиза не нужны.

## Отдельный выпуск SDK

Для выпуска npm-пакетов вручную запустите `Prepare SDK release` на `stable`. Workflow проверяет доступ к репозиторию через `DEPLOY_KEY`, повышает patch-версию обоих SDK командой Yarn, выполняет `yarn checks` и создаёт commit с `[skip ci]`. В commit входят только `packages/browser/package.json`, `packages/react/package.json` и изменения `yarn.lock`, созданные Yarn. После проверки состава и секретов commit отправляется в `stable`, затем через штатный `GITHUB_TOKEN` вызывается `SDK release` на точном SHA. Повторная попытка того же запуска переиспользует подготовленный commit. Этот процесс не запускает серверный deploy.

Версии фиксируются **до публикации**, чтобы npm provenance ссылался на соответствующий commit в GitHub. Например, оба SDK переходят с `0.1.1` на `0.1.2` одним commit. Если npm-публикация не удалась, повторите упавший `SDK release` на том же SHA: новая подготовка с актуальной `stable` создаст следующую patch-версию.

`SDK release` публикует только отсутствующие версии пакетов с provenance, сверяет состав существующих версий и проверяет скачанные из npm tarballs в browser/React fixtures. Последний job отправляет события этими опубликованными SDK в одноразовую Docker-установку. Только шаг публикации получает `NPM_TOKEN`.

Тег `stable` у Docker-образа служит указателем для человека. Установщик запускает точные digest из проверенного `release.json`. Обновление никогда не выбирает плавающий тег.

## Настройки GitHub перед первым выпуском

Репозиторий: `GetException/GetException`. Установщик рассчитан на публичные GitHub Releases и публичные GHCR packages. После первого создания packages проверьте их visibility и связь с этим репозиторием.

В настройках репозитория:

- Основная ветка `stable`; разрешены GitHub Actions и `workflow_dispatch`.
- Ruleset для `stable`: review, обязательный `Checks / checks`, запрет force push и удаления ветки. Точные названия status checks появляются после первого запуска.
- Создайте команду `GetException/maintainers` с write access либо замените её в `.github/CODEOWNERS` реальной командой. Включите обязательный review владельцев кода.
- Перед выпуском SDK создайте environment `release` с независимым approval. Добавьте `NPM_TOKEN` с правом публикации двух SDK в repository secrets либо secrets этого environment. Workflow передаёт токен только шагу публикации. Разрешите GitHub Actions публиковать в npm от имени владельца scope `@getexception`.
- Для подготовки SDK добавьте публичную часть отдельного SSH-ключа в **Settings → Deploy keys** с флагом **Allow write access**, а приватную часть целиком — в repository secret `DEPLOY_KEY`. Workflow использует этот ключ только для подготовки и push release commit. Для защищённой `stable` её правила должны разрешать такой commit; право записи ключа само по себе не обходит ruleset. `RELEASE_TOKEN` не нужен: встроенный `GITHUB_TOKEN` с `Actions: write` используется только для вызова `SDK release`. Обычные изменения проходят PR/review.
- Создайте environment `production` с обязательным approval и разрешением только для `stable`. Параллельные выпуски сериализованы через workflow concurrency, на сервере действует дополнительный lock.

Для обновления сервера используются следующие параметры. Variables и secrets можно задать на уровне репозитория или environment `production`; `DEPLOY_ENABLED` задаётся на уровне репозитория:

| Тип                 | Имя               | Назначение                                                                        |
| ------------------- | ----------------- | --------------------------------------------------------------------------------- |
| Repository variable | `DEPLOY_ENABLED`  | Оставить пустой до первой установки; затем `true`                                 |
| Variable            | `SSH_HOST`        | SSH hostname или IPv4 сервера                                                     |
| Variable            | `SSH_USER`        | Пользователь, которому принадлежат установка и Docker доступ                      |
| Variable            | `DEPLOY_PORT`     | По умолчанию `22`                                                                 |
| Variable            | `DEPLOY_DIR`      | По умолчанию `/opt/getexception`                                                  |
| Secret              | `SSH_KEY`         | Приватный ключ для доступа к серверу; публичная часть в его `authorized_keys`     |
| Secret              | `SSH_KNOWN_HOSTS` | Проверенная запись host key сервера; fingerprint сверяется по независимому каналу |

Для совместимости сохранены прежние имена `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` и `DEPLOY_KNOWN_HOSTS`: они используются, если соответствующие `SSH_*` не заданы. Значения сервера не зашиваются в workflow.

`DEPLOY_KEY` даёт GitHub Actions доступ к **репозиторию** для коммита версий. `SSH_KEY` даёт доступ к **серверу** для обновления приложения. Это разные ключи и направления подключения; `SSH_KNOWN_HOSTS` содержит публичный ключ самого сервера и не заменяет ни один из них.

SSH использует строгую проверку host key. CI не выполняет `ssh-keyscan` с автоматическим доверием и не создаёт новый Owner на сервере.

## Подготовка сервера

Поддерживается Linux amd64 с Docker Engine, Compose 2.24+, Python 3.9+, Bash, curl и актуальным GitHub CLI с `gh attestation verify`. Node/Yarn и исходники на сервере не нужны. Установщик проверяет prerequisites и не устанавливает Docker за оператора.

Для прототипа предусмотрите около 8 ГБ RAM, место для PostgreSQL, нескольких версий образов и backup. Назначьте два DNS имени серверу, например `monitor.example.com` и `ingest.monitor.example.com`. Порты 80/443 должны быть доступны Caddy. На сервере с уже работающим reverse proxy сначала согласуйте схему портов; этот Compose занимает 80/443.

Один deploy-пользователь должен иметь доступ к Docker и запись в каталог установки. Например, оператор заранее создаёт `/opt/getexception` с владельцем этим пользователем и правами `0700`. Последующие команды выполняются от того же пользователя. Настройте `gh auth login` с минимальным доступом для проверки публичных attestations. SMTP можно подключить позже; для внешней доставки нужен существующий почтовый сервис с TLS или STARTTLS. Тестовая почта в production не запускается.

## Первая установка

Выберите полный SHA **завершённого** GitHub Release. Контактный `ACME_EMAIL` можно оставить пустым: Caddy получает и продлевает сертификаты автоматически, подтверждая владение доменом через сервер. SMTP для этого не нужен. Если SMTP не указан, установщик сохраняет `MAIL_ENABLED=false`: Owner проходит обычный setup с TOTP, работает с проектами и ошибками; приглашения временно недоступны. Можно явно передать `MAIL_ENABLED=false`.

Чтобы сразу включить письма, задайте `MAIL_ENABLED=true`, `SMTP_HOST`, `SMTP_FROM`, `SMTP_PORT` (`587`), `SMTP_MODE` (`starttls` либо `tls`), при необходимости `SMTP_USER` и `SMTP_PASSWORD`. Для совместимости переданные `SMTP_HOST` или `SMTP_FROM` включают почту при отсутствии явного флага; неполная конфигурация в этом случае останавливает установку. Пароль удобно ввести через `read -rs SMTP_PASSWORD` и затем `export SMTP_PASSWORD`, чтобы он не оказался в истории shell. Переменные должны быть доступны процессу установщика.

Можно скачать, проверить и запустить установщик одной составной командой (вместо `RELEASE_SHA` подставляется полный SHA):

```bash
release=RELEASE_SHA; base="https://github.com/GetException/GetException/releases/download/deploy-$release"; curl -fLsS --proto '=https' --proto-redir '=https' "$base/install-getexception.sh" -o install-getexception.sh && curl -fLsS --proto '=https' --proto-redir '=https' "$base/install-getexception.sh.sha256" -o install-getexception.sh.sha256 && sha256sum --check install-getexception.sh.sha256 && gh attestation verify install-getexception.sh --repo GetException/GetException --signer-workflow GetException/GetException/.github/workflows/release.yml --source-ref refs/heads/stable --source-digest "$release" && bash install-getexception.sh --release "$release" --dashboard-host monitor.example.com --ingest-host ingest.monitor.example.com
```

Те же действия можно выполнить по очереди: скачать оба файла, проверить checksum, проверить attestation и только затем выполнить `bash install-getexception.sh ...`. Сам bootstrap дополнительно проверяет controller, а controller — checksum, attestation и содержимое архива. `--archive-url` позволяет указать другое HTTPS размещение bundle и соседнего `.sha256`; проверка identity и подписей остаётся обязательной.

Параметры `--install-dir /другой/каталог` и `--skip-start` поддерживаются. `--skip-start` скачивает проверенные файлы и создаёт конфигурацию, но не меняет работающую версию. Для запуска после подготовки повторите установку без `--skip-start`.

Если DNS кабинета уже работает, а DNS ingest ещё ожидается, при **первой** установке добавьте `--defer-ingest-dns`. Домен ingest всё равно задаётся отдельно. Установщик проверит доверенный HTTPS кабинета, закрытые маршруты и готовность внутренних сервисов; в `runtime/state.json` и `status` останется отметка `ingestDnsPending`. Owner можно создать и сохранить сразу. Внешний приём ошибок станет доступен после настройки DNS ingest и получения его сертификата. Флаг запрещён при обновлении, повторном запуске уже установленного сервиса и вместе с `--require-ingestion-smoke`.

После появления DNS дождитесь сертификата ingest (при длительном ожидании перезапустите только Caddy), создайте probe-проект по инструкции ниже и выполните `getexception smoke`. Успешная проверка снимет отметку. Только после этого включайте `DEPLOY_ENABLED`. Обычное обновление также проверяет отложенный ingest **до** остановки сервисов и миграций.

### Проверка подписей без GitHub-токена на сервере

На компьютере с настроенным GitHub CLI скачайте артефакты завершённого релиза и публичные доказательства подписи в отдельный каталог:

```bash
release=FULL_RELEASE_SHA
mkdir getexception-release
cd getexception-release
gh release download "deploy-$release" --repo GetException/GetException \
  --pattern 'install-getexception.sh*' --pattern 'getexception.tar.gz*'
gh attestation download getexception.tar.gz --repo GetException/GetException
gh attestation trusted-root > trusted-root.jsonl
```

Передайте каталог на сервер по проверенному SSH-соединению. Bundle `sha256:*.jsonl` содержит attestations всех трёх файлов релиза. В командах ниже замените `ATTESTATION_FILE.jsonl` его точным именем. На сервере, внутри переданного каталога:

```bash
release=FULL_RELEASE_SHA
sha256sum --check install-getexception.sh.sha256
gh attestation verify install-getexception.sh --repo GetException/GetException \
  --bundle ATTESTATION_FILE.jsonl --custom-trusted-root trusted-root.jsonl \
  --signer-workflow GetException/GetException/.github/workflows/release.yml \
  --source-ref refs/heads/stable --source-digest "$release"
bash install-getexception.sh --release "$release" \
  --attestation-bundle ATTESTATION_FILE.jsonl --trusted-root trusted-root.jsonl \
  --dashboard-host monitor.example.com --ingest-host ingest.monitor.example.com
```

Запускайте bootstrap только после успешной проверки checksum и подписи. Оба параметра offline-проверки передаются вместе; controller проверяет архив с теми же ограничениями identity. Токены GitHub на сервер не передаются. Доступ к интернету для скачивания артефактов, образов и HTTPS-сертификатов всё ещё нужен. При следующем обновлении передайте свежие доказательства для нового SHA и те же параметры команде `getexception update` либо настройте обычную онлайн-проверку через `gh auth login`.

После установки:

1. Откройте `https://monitor.example.com/setup`.
2. Прочитайте setup token из `/opt/getexception/runtime/setup-token` на сервере. Он не выводится в CI/log и не включается в URL. Срок первоначального токена — 24 часа с первой миграции; проходите setup сразу после установки.
3. Создайте Owner, подключите аутентификатор и сохраните recovery codes. Installation domain — hostname кабинета, уже указанный установщику.
4. Создайте проект и подключите SDK. Если почта включена, проверьте приглашение на существующий адрес.

Owner создаётся один раз. Повторная установка, обновление и перезапуск сохраняют его пароль, MFA, участников и данные. Установщик не обновляет значения уже существующего `.env`, даже если новые environment variables отличаются. Он удаляет локальную копию setup token при последующем успешном обновлении уже настроенной установки; в БД токен погашается сразу при регистрации.

Для последующего подключения почты измените только `MAIL_ENABLED="true"` и `SMTP_*` в `/opt/getexception/runtime/.env`, сохранив формат, права `0600` и все существующие ключи. Примените конфигурацию обычной командой `getexception update --release FULL_RELEASE_SHA`; можно использовать текущий проверенный SHA. При обновлении Compose пересоздаёт web и worker-mail с новыми значениями. Owner и база сохраняются. У существующих установок без `MAIL_ENABLED` почта остаётся включённой.

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
