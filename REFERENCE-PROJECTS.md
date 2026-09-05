# Выводы из Selfchecks и Selflify

## Область анализа

Анализ сделан по исходному коду, а не по описаниям на сайтах проектов.

Исследованы следующие версии:

- `selfchecks/selfchecks`, ветка `stable`, коммит [`606876507bbe56dffce9140e5c162bb1ccd29ebb`](https://github.com/selfchecks/selfchecks/tree/606876507bbe56dffce9140e5c162bb1ccd29ebb).
- `Selflify/Selflify`, ветка `stable`, коммит [`7211a5e6b1c04da8db506a69b7fee86fc647c246`](https://github.com/Selflify/Selflify/tree/7211a5e6b1c04da8db506a69b7fee86fc647c246).

Selfchecks имеет лицензию Elastic License 2.0, а Selflify имеет лицензию MIT. Для GetException можно использовать описанные ниже подходы, но код Selfchecks нельзя копировать без отдельной проверки условий его лицензии. Источники: [`LICENSE` Selfchecks, строки 1 to 20](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/LICENSE#L1-L20) и [`LICENSE` Selflify, строки 1 to 13](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/LICENSE#L1-L13).

## Что следует применить в GetException

### Структура monorepo и общие проверки

В Selfchecks приложения и пакеты разделены через Yarn workspaces `apps/*` и `packages/*`. Сборка в корне явно задаёт порядок зависимостей. Такой подход подходит для `apps/web`, `apps/ingest`, `apps/worker` и пакетов `@getexception`. Источник: [`package.json`, строки 6 to 38](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/package.json#L6-L38).

Оба проекта фиксируют Yarn 4 и используют `node_modules` вместо Plug and Play. GetException уже принял такое решение, поэтому его следует оставить. Источники: [`.yarnrc.yml` Selfchecks](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/.yarnrc.yml#L1) и [`.yarnrc.yml` Selflify, строки 1 to 3](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/.yarnrc.yml#L1-L3).

CI должен запускать ту же корневую команду `yarn checks`, которую разработчик запускает перед коммитом. В неё должны входить проверка форматирования, ESLint, typecheck, тесты, сборка, проверка Compose и проверка GitHub Actions через `actionlint`. Selflify уже проверяет workflow, код, тесты, типы, сборку и Compose, но запускает их отдельными командами. Источник: [`.github/workflows/ci.yml`, строки 21 to 51](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/.github/workflows/ci.yml#L21-L51).

### Запуск на сервере

Миграции базы должны выполняться отдельным одноразовым контейнером. Web, ingest и worker можно запускать только после успешной миграции. Selfchecks ждёт готовности PostgreSQL, запускает миграцию и затем разрешает старт приложений. Источник: [`docker-compose.prod.yml`, строки 7 to 68](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/docker-compose.prod.yml#L7-L68).

Тяжёлую обработку событий следует оставить в отдельном worker. Его процесс должен обрабатывать `SIGINT` и `SIGTERM`, прекращать получение новых задач и закрывать соединения перед завершением. Selfchecks делает такое завершение для worker и очереди. Источник: [`apps/worker/src/index.ts`, строки 53 to 114](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/apps/worker/src/index.ts#L53-L114).

Параллельность worker должна задаваться настройкой с нижней и верхней границей. Изменение числа параллельных задач не должно требовать новой сборки образа. Selfchecks проверяет значение настройки и применяет его к локальной и общей параллельности очереди. Источники: [`apps/worker/src/config.ts`, строки 35 to 109](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/apps/worker/src/config.ts#L35-L109) и [`apps/worker/src/index.ts`, строки 69 to 105](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/apps/worker/src/index.ts#L69-L105).

Retention лучше запускать отдельным процессом из того же worker образа. Тогда удаление старых событий не занимает слоты обработки новых событий. Selflify применяет отдельный контейнер `cleanup` с собственным интервалом и лимитами хранения. Источник: [`docker-compose.yml`, строки 21 to 37](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/docker-compose.yml#L21-L37).

Для каждого приложения нужны отдельные проверки живости и готовности. Проверка готовности ingest должна включать соединение с PostgreSQL и возможность записать задачу. Проверка worker должна показывать возраст последней успешно обработанной задачи и отставание очереди. В Selfchecks есть хорошие проверки PostgreSQL и Redis, но Caddy ждёт только запуска процесса web. GetException должен расширить этот подход. Источник: [`docker-compose.prod.yml`, строки 17 to 54 и 132 to 150](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/docker-compose.prod.yml#L17-L54).

### Установка, обновление и откат

Нужно выпускать небольшой bootstrap архив с Compose, шаблонами конфигурации и установщиком. Установщик должен создавать секреты, права `0600` и каталоги runtime только при их отсутствии. Повторный запуск не должен перезаписывать конфигурацию и секреты. Такой порядок есть в установщике Selfchecks. Источник: [`scripts/install-selfchecks.sh`, строки 124 to 245 и 261 to 283](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/scripts/install-selfchecks.sh#L124-L245).

Bootstrap нужно проверять как самостоятельный артефакт. Минимальный тест должен распаковать архив во временный каталог, запустить установщик без системных изменений и проверить созданные файлы и секреты. Selfchecks выполняет такую проверку. Источник: [`scripts/smoke-bootstrap.sh`, строки 15 to 56](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/scripts/smoke-bootstrap.sh#L15-L56).

Перед production deploy нужен тест опубликованного bootstrap артефакта, а не только исходного скрипта из checkout. Selflify устанавливает опубликованный release, ждёт `/setup`, проходит первый запуск и только после этого допускает deploy. Источник: [`.github/workflows/deploy.yml`, строки 168 to 255](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/.github/workflows/deploy.yml#L168-L255).

Образы нужно публиковать с неизменяемым тегом `sha-<commit>`. Production deploy должен записывать предыдущий тег, запускать миграцию, обновлять сервисы и проверять готовность. При ошибке до точки совместимости миграции deploy должен вернуть предыдущий тег. Оба проекта публикуют SHA теги, но запускают production через изменяемый тег `stable` и не реализуют полный откат. Источники: [Selfchecks deploy, строки 180 to 213](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/.github/workflows/deploy.yml#L180-L213) и [Selflify deploy, строки 79 to 127](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/.github/workflows/deploy.yml#L79-L127).

Изменения runtime конфигурации нужно выполнять последовательно. Перед записью следует проверить ожидаемую ревизию, сохранить резервную копию, проверить новую конфигурацию и восстановить предыдущую при ошибке. Selflify реализует блокировку, номер ревизии, резервную копию и откат Caddy. Источники: [`src/lib/operations.ts`, строки 144 to 267](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/src/lib/operations.ts#L144-L267) и [`src/lib/config/backups.ts`, строки 29 to 101](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/src/lib/config/backups.ts#L29-L101).

### Первый запуск и безопасность

Страница первого запуска должна быть закрыта одноразовым setup token из файла окружения. Сравнение токена должно занимать постоянное время. После настройки root пользователя повторный вызов setup должен быть запрещён на сервере. Selflify выдаёт короткую cookie доступа после проверки токена, а Selfchecks проверяет, что администратор ещё не создан. Источники: [`src/lib/auth/setup-access.ts`, строки 5 to 91](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/src/lib/auth/setup-access.ts#L5-L91) и [`apps/web/app/api/setup/route.ts`, строки 30 to 75](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/apps/web/app/api/setup/route.ts#L30-L75).

GetException должен хранить root пользователя, пароль и TOTP в PostgreSQL, а не в JSON конфигурации. После смены пароля или отключения пользователя следует отозвать его активные сессии. В Selflify сессия привязана к имени пользователя и времени настройки администратора. Подход с версией учётных данных можно перенести в отдельное поле пользователя. Источник: [`src/lib/auth/guards.ts`, строки 6 to 35](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/src/lib/auth/guards.ts#L6-L35).

Вызовы системных программ нужно выполнять без shell, передав аргументы отдельным массивом. Для каждого вызова нужны timeout и предел размера вывода. Selflify использует `execFile` с такими ограничениями. Источник: [`src/lib/system/commands.ts`, строки 47 to 79](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/src/lib/system/commands.ts#L47-L79).

### Совместимые npm пакеты

Совместимость с Sentry следует описать как конечный список экспортов, методов и параметров. Неподдерживаемые параметры должны давать понятную ошибку или быть явно описаны, а не молча игнорироваться. Selfchecks перечисляет поддерживаемые импорты и ограничения совместимости с Checkly. Источник: [`packages/checkly-compat/README.md`, строки 78 to 115](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/packages/checkly-compat/README.md#L78-L115).

Миграционный путь нужно проверять через npm alias. Для GetException это означает тестовые проекты, где `@sentry/browser` или `@sentry/react` заменены на соответствующий пакет `@getexception` через alias. Selfchecks документирует такой способ замены пакета. Источник: [`packages/checkly-compat/README.md`, строки 78 to 89](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/packages/checkly-compat/README.md#L78-L89).

Публикация должна быть повторяемой. Job сначала проверяет наличие версии в npm, затем публикует только отсутствующие версии с public access и provenance. После публикации отдельный smoke test должен скачать пакеты из npm и собрать небольшие проекты для browser и React. Selfchecks применяет такую схему публикации и ждёт появления пакетов в registry. Источник: [`.github/workflows/deploy.yml`, строки 276 to 409](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/.github/workflows/deploy.yml#L276-L409).

Версии связанных публичных пакетов нужно менять одной проверяемой операцией. Скрипт Selfchecks сначала проверяет, что версии совпадают, а затем меняет все manifests и встроенные маркеры версии. Источник: [`scripts/bump-npm-package-versions.mjs`, строки 47 to 104](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/scripts/bump-npm-package-versions.mjs#L47-L104).

### Тесты

Первая итерация должна иметь тест полного пути установки. Тест должен установить опубликованный bootstrap, открыть `/setup`, создать root пользователя, настроить домен, войти, создать проект, отправить событие через `@getexception/browser` и увидеть issue в кабинете. Selflify показывает, как отдельно проверять первый запуск и опубликованный установщик. Источники: [`e2e/first-launch.spec.ts`, строки 11 to 87](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/e2e/first-launch.spec.ts#L11-L87) и [`e2e/bootstrap-install.spec.ts`, строки 29 to 67](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/e2e/bootstrap-install.spec.ts#L29-L67).

E2E тесты должны сохранять trace, screenshot и video только для неудачных запусков. В логах и артефактах нельзя хранить DSN secret, session secret, TOTP seed или исходный payload ошибки. Selflify задаёт полезные параметры Playwright для диагностики. Источник: [`playwright.config.ts`, строки 11 to 25](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/playwright.config.ts#L11-L25).

Для тестов приёма ошибок нужен небольшой набор очищенных событий. В него следует включить Sentry envelope, обычный JSON event, исключение с цепочкой причин, React error boundary, событие с source map, повтор события, слишком большой payload и поля с секретами. Fixtures должны быть вымышленными и не должны содержать выгрузки из production.

## Что не следует переносить

- Redis и BullMQ не нужны в первой итерации только потому, что они есть в Selfchecks. Для заданной нагрузки PostgreSQL inbox проще. Переход на отдельный broker нужен после измерений или при нескольких серверах ingest. Selfchecks также задаёт `attempts: 1`, поэтому его настройку повторов нельзя использовать как образец для доставки ошибок. Источник: [`apps/worker/src/config.ts`, строки 68 to 88](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/apps/worker/src/config.ts#L68-L88).
- Нельзя запускать установку Docker через `curl ... | sh` и нельзя без проверки выполнять bootstrap через такой pipeline. Нужно скачать файл, проверить SHA256 или подпись и только потом запустить его. Оба проекта сейчас выполняют удалённый код напрямую. Источники: [установщик Selfchecks, строки 96 to 121](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/scripts/install-selfchecks.sh#L96-L121) и [Selflify deploy, строки 197 to 207](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/.github/workflows/deploy.yml#L197-L207).
- Нельзя считать `service_started` проверкой готовности web. Нужен HTTP endpoint readiness, который проверяет нужные зависимости. Selfchecks запускает Caddy после старта контейнера web без проверки приложения. Источник: [`docker-compose.prod.yml`, строки 132 to 150](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/docker-compose.prod.yml#L132-L150).
- Нельзя использовать изменяемый тег `stable` как единственный способ выбрать production образ. Такой тег мешает проверить состав релиза и надёжно откатиться. Оба Compose файла используют `stable` по умолчанию. Источники: [Selfchecks Compose, строки 1 to 4](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/docker-compose.prod.yml#L1-L4) и [Selflify Compose, строки 1 to 4](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/docker-compose.yml#L1-L4).
- Нельзя хранить пароль root пользователя, TOTP seed или внешний API token в общем JSON файле runtime. Selflify допускает пароль и Cloudflare token в одном файле конфигурации. В GetException такие значения должны храниться отдельно, быть зашифрованы или хешированы по назначению и никогда не возвращаться в API. Источник: [`src/lib/config/schema.ts`, строки 60 to 90](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/src/lib/config/schema.ts#L60-L90).
- Нельзя переносить cookie setup без изменения флага `secure`. Selflify ставит `secure: false`. В GetException production cookie должна иметь `Secure`, `HttpOnly`, ограниченный срок жизни и подходящий `SameSite`. Источник: [`src/lib/auth/setup-access.ts`, строки 83 to 91](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/src/lib/auth/setup-access.ts#L83-L91).
- Нельзя использовать rate limit входа только в памяти процесса. Счётчики Selflify исчезают при перезапуске и не работают между репликами. GetException должен хранить блокировки в PostgreSQL или другом общем хранилище. Источник: [`src/lib/auth/login-rate-limit.ts`, строки 1 to 12 и 135 to 165](https://github.com/Selflify/Selflify/blob/7211a5e6b1c04da8db506a69b7fee86fc647c246/src/lib/auth/login-rate-limit.ts#L1-L12).
- Нельзя автоматически удалять все неиспользуемые Docker образы во время deploy. Команда `docker system prune -af` может удалить образ, который нужен для отката. Selfchecks выполняет такую очистку перед обновлением. Источник: [`.github/workflows/deploy.yml`, строки 724 to 751](https://github.com/selfchecks/selfchecks/blob/606876507bbe56dffce9140e5c162bb1ccd29ebb/.github/workflows/deploy.yml#L724-L751).

## Итог для первой итерации

Первая итерация GetException должна использовать Yarn workspaces, PostgreSQL inbox, отдельные процессы ingest, web, обработки событий и retention, одноразовый контейнер миграции, Caddy и неизменяемые образы по SHA. Ей также нужны закрытый setup, root пользователь в PostgreSQL, TOTP, проверки готовности, проверяемый bootstrap, откат конфигурации и полный E2E путь от установки до появления issue.

Redis, BullMQ и отдельный сервер очереди пока не нужны. Архитектура должна оставить возможность добавить broker без изменения публичного ingest API.
