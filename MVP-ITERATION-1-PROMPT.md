# Промпт для создания первой итерации GetException

Реализуй в текущем репозитории первую рабочую итерацию MVP GetException. Не ограничивайся планом: создай код, миграции, тесты, Docker Compose и документацию, затем запусти проверки.

## Сначала изучи требования

До изменений полностью прочитай:

- `AGENTS.md`;
- `0001-sentry-compatible-error-monitoring-platform.md`;
- `CONTEXT.md`;
- `SECURITY-AUDIT.md`;
- `REFERENCE-PROJECTS.md`.

ADR и security audit являются источником истины. Если этот промпт короче или менее точен, следуй им. Не меняй принятое архитектурное решение молча. Если без изменения ADR нельзя продолжить, сначала опиши противоречие.

Сохрани существующие пользовательские изменения. Не создавай commit и не выполняй push, если об этом не попросят отдельно.

## Цель итерации

Собери минимальный сквозной путь:

1. оператор открывает новую установку и проходит защищённый `/setup`;
2. он задаёт домен, создаёт root-пользователя и настраивает TOTP;
3. root-пользователь входит в кабинет и создаёт проект;
4. кабинет выдаёт публичный write-only DSN;
5. fixture обычного browser SPA или React SPA отправляет ошибку через пакет `@getexception`;
6. ingest проверяет и очищает событие, затем надёжно записывает его в PostgreSQL inbox;
7. worker асинхронно обрабатывает событие и создаёт или обновляет группу ошибки;
8. ошибка появляется в списке и на странице группы в кабинете.

Это должна быть работающая вертикальная часть продукта, а не набор пустых директорий и заглушек.

## Структура monorepo

Используй Yarn workspaces и обычный `node_modules`. Plug and Play запрещён. Сохрани scope `@getexception`.

Создай или доведи до рабочего состояния:

```text
apps/
  web/
  ingest/
  worker/
packages/
  browser/
  react/
  protocol/
  db/
  config/
fixtures/
  browser-spa/
  react-spa/
```

`@getexception/browser` и `@getexception/react` являются публичными пакетами. Все внутренние пакеты должны иметь `private: true`. Пакет CLI и source maps можно оставить на следующую итерацию, но их будущая граница не должна требовать переделки ingest или модели релиза.

Закрепи версии Node, Yarn и зависимостей. Для документации библиотек следуй правилам из `AGENTS.md`. Не добавляй зависимость без объяснимой пользы.

## Обязательная реализация

### Web

Используй Next.js App Router, `@base-ui/react`, Tailwind CSS и семантические CSS variables.

Реализуй:

- `/setup`, доступный только до завершения первоначальной настройки и только после проверки одноразового setup token;
- двухэтапную настройку TOTP: encrypted pending credential, проверку первого кода и только затем атомарное создание системной настройки, root-пользователя, роли Owner и active credential;
- одноразовые recovery codes, которые показываются один раз и хранятся только как хеши;
- уничтожение setup token после успеха и серверный запрет повторного setup;
- вход по email, паролю и TOTP без Google OAuth;
- защищённую сессию в host-only cookie кабинета;
- `mfa_verified_at` в сессии и step-up не старше пяти минут для опасных действий;
- создание проекта и выпуск публичного DSN;
- список групп ошибок;
- страницу группы с последними событиями и очищенным stack trace.

Для этой итерации можно не делать приглашения, команды, полный RBAC и восстановление пароля. При этом authorization должен находиться на сервере, а схема данных должна позволять добавить роли и команды без переноса данных из временной модели.

Не добавляй открытый signup route как временное упрощение. Root должен быть отдельным Account с отдельным Owner Member в единственном workspace. В README следующей итерации зафиксируй, что приглашения будут привязаны к нормализованному email, роли и нескольким командам. Они будут использовать одноразовый хешированный token, подтверждение email до приёма пароля и атомарное создание Member. Не добавляй многоразовые invitation links.

TOTP secret должен содержать не менее 160 случайных бит. Используй шесть цифр, период 30 секунд и окно из текущего и двух соседних периодов. Сравнивай код за постоянное время. Храни versioned AES-256-GCM ciphertext с отдельным 32-байтным production key, случайным nonce и authenticated additional data из user ID и состояния `pending` или `active`. Web должен завершаться до открытия порта, если production key отсутствует или неверен.

Храни номер последнего принятого TOTP периода и обновляй его под блокировкой строки в той же транзакции, которая создаёт сессию или подтверждает step-up. Один код нельзя принять дважды, включая два параллельных запроса. Ответы TOTP setup, status и step-up получают `Cache-Control: no-store`. Audit log хранит результат операции, но не password, secret, TOTP code или recovery code.

Better Auth остаётся системой аккаунтов и сессий. При TOTP verification всегда передавай `trustDevice: false`, а сервер должен отклонять trusted-device режим для Owner. Проверь хранение secret и recovery codes выбранной версией Better Auth. Если оно не выполняет требования ADR, добавь узкий серверный adapter и отдельные таблицы. Не заменяй Owner TOTP кодом из email.

### Ingest

Создай отдельный Node.js/TypeScript процесс. Он не должен быть route handler внутри Next.js.

Реализуй Sentry-совместимый endpoint:

```text
POST /api/<project-id>/envelope/
```

Поддержи только нужное подмножество error event для первой итерации. Ограничь размер HTTP body, число Envelope items, размер item, глубину JSON, количество полей и длину строк. Не используй обычный неограниченный `JSON.parse` для произвольного большого payload.

До записи в inbox:

- проверь project ID и хеш публичного DSN key;
- проверь допустимый Origin для браузерного запроса;
- отклони неподдерживаемые item types;
- пропусти событие через строгий allow-list и sanitizer;
- удали cookies, headers, query string, request body, form data, local/session storage, пользовательские данные и произвольный context;
- назначь серверный `received_at`;
- обеспечь идемпотентность по паре project ID и event ID.

Успешный ответ отправляется только после durable insert в PostgreSQL inbox. Symbolication, grouping и retention не выполняются в request path. При переполнении или лимите верни `429`, при недоступной БД не подтверждай приём. Не записывай исходный payload или секреты в логи.

### Worker

Используй один worker image с двумя runtime-режимами:

- `worker-events` обрабатывает новые inbox records и допускает несколько реплик;
- `worker-retention` запускается в одном экземпляре и удаляет данные небольшими пакетами.

Получай задачи параметризованным SQL через `FOR UPDATE SKIP LOCKED` в короткой транзакции. Не удерживай транзакцию во время всей обработки. Добавь attempts, `next_attempt_at`, dead-letter state и безопасный retry. Обработка должна быть идемпотентной.

Для первой итерации worker должен нормализовать stack trace, вычислять базовый fingerprint, создавать или обновлять issue group, сохранять событие и счётчики. Полную symbolication через source maps можно отложить. Отсутствие этой функции явно зафиксируй в README как границу итерации.

Параллельность `worker-events` задаётся настройкой с нижней и верхней границей. Обработай SIGINT и SIGTERM: прекрати брать новые задачи, корректно заверши или освободи текущие и закрой соединения.

### Пакеты для SPA

Реализуй минимальное совместимое подмножество API:

- `init`;
- `captureException`;
- `captureMessage` только для `error` и `fatal`;
- `setTag` и `setTags`;
- `setContext` только в пределах разрешённой схемы;
- `addBreadcrumb` только для безопасной технической истории;
- `withScope`;
- `flush` и `close` с коротким timeout;
- автоматический перехват `window.error` и `unhandledrejection`;
- `ErrorBoundary` в `@getexception/react`.

Публичная сигнатура должна позволять заменить поддерживаемые импорты `@sentry/browser` и `@sentry/react` с минимальными изменениями. Составь таблицу совместимости. Неподдерживаемые возможности не должны молча обещать работу.

Transport отправляет только на HTTPS origin из DSN через `fetch` с `credentials: "omit"` и `referrerPolicy: "no-referrer"`. Импорт пакета ничего не собирает и не отправляет до `init`. Ошибка GetException не должна ломать наблюдаемое SPA.

Создай browser и React fixtures. Добавь отдельную проверку миграции через npm alias, при которой импорт Sentry заменяется на соответствующий пакет `@getexception`.

### PostgreSQL и права

Используй миграции Prisma для обычной схемы и параметризованный SQL только там, где нужен конкурентный claim inbox.

Минимальная модель должна включать system settings, workspace, accounts, members, credentials или auth state, sessions, projects, DSN keys, inbox, events и issue groups. Секреты храни по правилам ADR. Пароль и DSN key хранятся только в виде стойкого хеша, TOTP имеет отдельные pending и active состояния, recovery codes хранятся как хеши, а setup token является одноразовым.

Auth rate limit должен хранить bucket в PostgreSQL и считать попытки одновременно по IP и нормализованной учётной записи. В таблицу попадает только хеш identifier. Две реплики web должны видеть один счётчик.

Подготовь отдельные роли PostgreSQL для web, ingest, worker, migrate и backup. Ingest должен иметь только минимальные права на проверку project key и запись очищенного inbox record. Он не должен читать auth, session или готовые events.

### Docker и локальный запуск

Создай Docker Compose с сервисами:

- `postgres`;
- `migrate`;
- `caddy`;
- `web`;
- `ingest`;
- `worker-events`;
- `worker-retention`.

Runtime-сервисы запускаются только после успешной миграции и readiness зависимостей. Добавь отдельные liveness и readiness endpoints. Readiness ingest проверяет способность записать в inbox. Worker сообщает глубину очереди и возраст старейшей задачи без публикации метрик в интернет.

Caddy должен направлять dashboard и ingest на разные локальные hosts, чтобы E2E проверял настоящие границы cookie, CORS и routes. Dashboard не принимает Envelope, а ingest не обслуживает auth или dashboard API.

Не добавляй Redis или BullMQ. Не устанавливай Docker автоматически. Не используй изменяемый тег `stable` как единственный production identifier.

Добавь `.env.example` только с пустыми секретами и безопасными примерами. `NPM_TOKEN` может находиться только в локальном `.env` или GitHub Secret. Он не нужен runtime-контейнерам.

## Проверки

Расширь корневую команду `yarn checks`, чтобы она запускала как минимум:

- Prettier check;
- ESLint;
- TypeScript typecheck;
- architecture check для зависимостей и runtime-границ workspaces;
- unit tests;
- сборку приложений и пакетов.

Добавь integration tests с настоящим PostgreSQL для:

- атомарности первого setup;
- запрета повторного setup;
- активации TOTP только после первого корректного кода;
- шифрования pending и active secret с привязкой к user ID и состоянию;
- входа с TOTP и запрета повторного или параллельного использования одного кода;
- запрета trusted-device и email OTP bypass для Owner;
- общего auth rate limit между двумя экземплярами web;
- `Cache-Control: no-store` и отсутствия MFA secrets в audit log;
- очистки чувствительных полей;
- durable inbox insert;
- двух параллельных worker без двойной обработки;
- retry и dead letter;
- идемпотентности project ID + event ID;
- недоступности чтения закрытых таблиц ролью ingest.

Добавь Playwright E2E полного пути от `/setup` до появления ошибки в кабинете. Сохраняй trace, screenshot и video только при ошибке. Не допускай секреты, TOTP seed, DSN key и исходные payload в CI artifacts.

Проверь Compose через `docker compose config`. Запускай `yarn install --immutable`. Перед завершением обязательно выполни `yarn checks` и подходящие integration/E2E проверки. Если Docker недоступен, выполни всё независимое от него и точно перечисли непройденные проверки.

## Что не входит в первую итерацию

Не трать время на:

- source map upload, CLI и symbolication;
- приглашения, команды и полный набор ролей;
- SMTP и восстановление пароля;
- transactional mail outbox и `worker-mail`;
- уведомления;
- performance tracing, replay, profiling и логи как продукт;
- production deploy, автоматический release commit и публикацию пакетов;
- отдельный лендинг `getexception.github.io`.

Оставь для этих функций явные границы модулей и короткий список следующей итерации, но не создавай фиктивные реализации.

Для следующей итерации считай раздел приглашений в ADR и `REFERENCE-PROJECTS.md` готовым контрактом. Не проектируй альтернативную модель приглашений внутри первой итерации.

## Результат

В конце покажи:

1. что реализовано;
2. ключевые архитектурные решения;
3. какие файлы созданы и изменены;
4. результаты `yarn checks`, integration tests, E2E и `docker compose config`;
5. известные ограничения первой итерации;
6. следующий минимальный шаг.
