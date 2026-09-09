# Проверки

Все команды запускаются из корня с Node 24.4.0 и Yarn 4.17.1. `yarn checks` — обязательная проверка перед любым коммитом. Эта реализация не создаёт коммитов и не публикует пакеты.

```bash
yarn install --immutable
yarn local:mailpit
yarn checks
yarn test:e2e
docker compose config --quiet
```

`checks` последовательно выполняет Prettier, ESLint, architecture check, проверки установщика/workflow/секретов/лицензий, аудит зависимостей, обе генерации Prisma client, TypeScript, unit tests, сборку серверов/SDK/Next.js/fixtures, npm-alias smoke и интеграционные тесты. На Linux он также запускает Docker bootstrap/update/rollback/restore test; в CI Docker обязателен. На macOS контейнерный тест явно пропускается. Нужны доступ к registry, проверенные инструменты из `yarn ci:tools`, Mailpit и разрешение локальных сокетов. Запущенный продукт и его runtime secrets не используются. `yarn test:integration` доступен отдельно для повторной проверки серверных изменений.

## Форматирование и читаемость

`yarn format` выполняет ESLint с автоисправлением, затем Prettier. Для отдельного запуска линтера доступны `yarn lint` и `yarn lint:fix`; `yarn format:check` проверяет стиль Prettier. Оба вида проверок уже входят в `yarn checks`.

Prettier задаёт два пробела, двойные кавычки, точки с запятой и переносы строк. ESLint Stylistic добавляет пустые строки после группы импортов, между функциями и методами, после блоков и перед `return`, `throw`, `if`, циклами, `switch` и `try`. Условия и циклы используют фигурные скобки. Соседние импорты и короткие объявления переменных можно сохранять одной группой. `.editorconfig` задаёт одинаковые базовые отступы для редакторов.

Generated Prisma clients, Next.js build files, artifacts и `runtime` исключены из форматирования и линтинга.

## Unit и architecture

`yarn test` проверяет bounded parser и malformed corpus, prototype pollution, независимую очистку PII/URL, limits, AES-GCM/AAD, RFC TOTP, конфигурацию, fingerprint, безопасные параметры фильтров кабинета и SDK transport. SDK тесты проверяют отсутствие активности до init, HTTPS, credentials/referrer, безопасный allow-list и подавление сетевых ошибок.

Architecture check разбирает imports/exports/require/dynamic import через TypeScript AST: разрешённые зависимости workspaces, отсутствие относительных переходов между ними, запрет серверных зависимостей в SDK и auth/background runtime в ingest. Он также запрещает unsafe Prisma API, eval и raw HTML. Это дополнительный барьер, а не полноценный security audit.

`yarn test:alias` требует уже собранные SDK. Реальные `yarn pack` tarballs устанавливаются в чистый проект через npm alias и временный registry на loopback. Проверяются immutable install, exports и TypeScript-потребитель. Registry metadata и cache изолированы; дата версии в фиктивном registry нужна только для воспроизводимой локальной установки. Публичный registry и его age gate не изменяются. NPM_TOKEN не передаётся дочерней установке.

## Настоящий PostgreSQL

По умолчанию `yarn test:integration` поднимает PostgreSQL 17 через закреплённый dev-only `embedded-postgres`. Это настоящий сервер с миграциями, SQL locks и SQL permissions, не mock или SQLite. Данные и случайные credentials находятся во временном каталоге с закрытыми правами и удаляются после остановки. Сервер слушает только loopback. На Unix запускайте тесты обычным пользователем, не root. Нужны platform binaries и разрешение запуска локальных процессов/сокетов. Postinstall helper восстанавливает только относительные symlinks внутри пакета с бинарником.

Альтернатива — `INTEGRATION_ADMIN_URL` на **пустой выделенный PostgreSQL cluster** с БД, имя которой заканчивается `_test`. Тест отказывается использовать cluster с существующими GetException runtime roles. Нужен test-only superuser для создания ролей и отдельной upgrade DB. Внешний cluster не удаляется автоматически; после теста уничтожьте его операторским способом. Никогда не указывайте рабочую БД.

Проверяются setup pending/atomic activation/rollback/concurrency/repeat denial, AES binding к состоянию и user, TOTP replay, recovery one-use, trusted-device/email OTP rejection, общие rate buckets, настоящие Better Auth cookies и transaction context, step-up concurrency/freshness, no-store, audit privacy. Вторая группа проверяет реальные SQL grants, readiness rollback, отключённое соединение БД → 503, sanitizer/durable ack/idempotence/CORS/429, параллельные workers, stale lease fencing, retry/dead-letter и retention. Отдельно проверяются Resolve/Reopen, идемпотентность, права изменения только status/regression, отказ при устаревшем счётчике, Regression при новом событии и конкурентной блокировке. Миграции проверяются на пустой БД и при последовательном обновлении четырёх версий с данными.

Отдельный integration-тест постоянного локального запуска создаёт аккаунт с MFA, сессию, проект, ключ и событие, останавливает настоящий PostgreSQL и запускает его с сохранённой конфигурацией. Проверяются прежняя сессия и вход с прежним TOTP, сохранность данных/ключей, закрытый setup и права `0600`. Unit-тесты проверяют отказ от генерации новых ключей при утрате конфигурации и исключение чужих секретов из окружения дочерних процессов.

## Playwright через Caddy HTTPS

Сначала выполните `yarn checks`. Нужны Chromium, Python 3 (очистка failure trace) и **Caddy 2.10.2**, установленный оператором из официального release с проверкой SHA512 из соответствующего release checksums файла. Укажите абсолютный путь:

```bash
yarn playwright install chromium
CADDY_BINARY=/absolute/path/to/caddy yarn test:e2e
```

Можно использовать существующий Chromium через `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Для этой проверки использован установленный Chromium build 1208; CI должен установить версию через закреплённый Playwright 1.63.0. При отсутствии `CADDY_BINARY` helper ищет `.artifacts/tools/caddy` (каталог игнорируется Git).

E2E сам запускает временный PostgreSQL, собранные web/ingest/worker и **тот же `docker/Caddyfile`** с разными HTTPS hosts и случайными портами. Не нужно создавать `.env` и проходить ручной setup. Chromium использует localhost mapping; прямые проверки API подключаются к loopback с корректными SNI и Host. Локальные сертификаты тестового CA принимаются только в тестовом browser context.

Сценарий проходит setup, ручной seed/первый TOTP, recovery screen, Owner login, cookie attributes и реальный запрос без cookie на ingest, закрытые auth routes, status/step-up no-store, выдачу DSN, ошибки обоих fixtures, разделение routes, восемь разделов, поиск и фильтры Issues, Events/Breadcrumbs и клавиатурное переключение вкладок, предыдущие/следующие события, Resolve/Regression, страницы проектов и релизов, просмотр Teams/Members/Audit/Settings, отсутствие горизонтального переполнения карточки на мобильной ширине. Canary из URL/cookie/storage проверяется в фактическом SDK-запросе и в PostgreSQL.

### Приватность artifacts

Во время setup/login/выдачи DSN и fixture traffic trace, video и screenshots **отключены**, автоматический DOM failure context отключён. Ошибки этих фаз заменяются общим сообщением с именем этапа, без значений credentials и payload. Это намеренно сокращает диагностику чувствительной части теста.

Только отдельный context уже заполненного, очищенного dashboard допускает запись. При успешной проверке trace/video удаляются; отдельные screenshots Overview/Issues/карточки на desktop и mobile с тестовыми очищенными данными сохраняются для визуальной проверки; при ошибке сохраняются screenshot, video и trace. Перед attachment trace удаляет network resources/requests/headers, source files и параметры browser API. Если sanitization не удалась, trace удаляется. Не включайте глобальный `trace: on` или запись sensitive context. CI должен загружать только очищенные attachments из `test-results`, не `.env`, временные PostgreSQL каталоги, runtime или `.artifacts`.

## Docker

`docker compose config --quiet` требует заполненный `.env` (`yarn local:env`) и Docker Compose v2. Затем нужны `docker compose up --build`, healthchecks, проверка Linux images и сквозной ручной путь из README. Native E2E проверяет процессы и Caddy routing, но не Dockerfile, namespaces, volumes и network policies Compose.

Docker автоматически не устанавливается. При его отсутствии обязательны независимые проверки, а Docker config/build/start должны быть отмечены как непройденные, не как успешные.

## Результат в среде реализации

Проверки в среде реализации 7 сентября 2026 года:

| Проверка                                                     | Результат                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `yarn install --immutable`                                   | Успешно.                                                                        |
| `yarn checks`                                                | Успешно: format/lint/architecture/types, 31 unit tests, сборки и оба npm alias. |
| `yarn test:integration`                                      | 20 тестов успешно на настоящем PostgreSQL 17.9, включая миграции.               |
| `yarn test:e2e`                                              | Полный сценарий успешно в Chromium через Caddy HTTPS.                           |
| `caddy validate`                                             | Успешно для `docker/Caddyfile`.                                                 |
| `docker compose config --quiet`                              | Не выполнено: `docker: command not found`.                                      |
| Docker images build / Compose start / container healthchecks | Не проверены: Docker отсутствует.                                               |

Node 24.4.0, Yarn 4.17.1, Darwin x64, Chromium build 1208. Native PostgreSQL имеет ту же major-версию, но другой patch, чем Compose image; Docker-проверки остаются обязательным следующим шагом. Vite предупреждает о размере React fixture bundle (~662 kB minified, ~182 kB gzip): это тестовый fixture с React и SDK, size optimization не проводилась.

## Роли и приглашения · 8 сентября 2026

Для отдельного запуска интеграционных проверок сначала соберите приложение (`yarn build` после `yarn generate`). Нужен `yarn local:mailpit` либо `MAILPIT_BINARY`. В `yarn checks` сборка уже стоит перед тестами. Почтовый тест запускает временный ящик на случайных loopback-портах, без реальных писем.

`yarn checks` прошёл полностью: форматирование, линтер, архитектура, типы, **34 unit-теста**, сборки и оба npm alias.

`yarn test:integration`: **34 теста прошли**. Проверены подтверждение email до пароля, параллельная регистрация, Developer/Viewer, несколько команд, смена ролей и отзыв сессий, последний Owner, включение/отключение MFA, повышение с MFA, resend/revoke, устаревшие leases, SQL-права почтовой роли и ограничение повторов outbox. Отдельный тест запускает собранный web-сервер и проверяет HTTP-ответы страниц приглашения, nonce для скриптов в CSP, no-store и закрытые API. Настоящая SMTP-доставка проверена в Mailpit; зависший SMTP закрывается по таймауту. Миграции применены на пустой и предыдущей схеме; сохранение данных при native restart также проверено.

Браузерный прогон этой доработки оставлен пользователю: [сценарий приёмки](manual-testing-members.md). Предыдущий успешный E2E относится к прошлой итерации. Docker/production SMTP остаются непроверенными.

## Подготовка CI/CD — 9 сентября 2026

Локальный `yarn checks` прошёл: форматирование, ESLint, architecture, TypeScript, сборка всех приложений и SDK, npm alias smoke, 34 unit и 34 PostgreSQL integration tests. Аудит npm не сообщил замечаний выбранного критического уровня. Дополнительно выполнены 19 Python tests установщика и повторного выпуска образов, actionlint 1.7.12, gitleaks 8.30.1, проверка лицензий и обеих Compose-конфигураций через официальный Compose 2.39.4 CLI. Проверена передача SMTP пароля со спецсимволами через dotenv без shell evaluation.

Docker Engine на этом Mac отсутствует: Linux Docker build/start, restore в контейнере, опубликованный bootstrap/npm provenance и CI→SSH здесь не запускались. Они подготовлены в обязательных GitHub Actions jobs; это не отчёт об их успешном прохождении. Реальный сервер не изменялся, локальный Owner и его данные сохранены.

`yarn test:compose` на Linux создаёт отдельный случайный Compose project и временный каталог. Он проверяет регистрацию Owner/TOTP, пять SDK событий и группировку, совместимое обновление/откат, сохранение сессии, backup и восстановление в пустую БД. После теста удаляются только его собственные volumes. Registry/bootstrap jobs повторяют сценарий с опубликованными артефактами. Подключение реального SMTP, публичного TLS и SSH выполняется на этапе развёртывания по [инструкции](deployment.md).
