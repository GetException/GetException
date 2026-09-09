# Реализованные границы

Основной контракт остаётся в [ADR-0001](../0001-sentry-compatible-error-monitoring-platform.md), [CONTEXT](../CONTEXT.md) и [security audit](../SECURITY-AUDIT.md). Этот файл описывает фактическую первую итерацию и её эксплуатационные пределы.

## Identity и MFA

Better Auth 1.6.23 управляет идентификаторами Account, password credentials, сессиями, подписью и удалением cookies. В Prisma `User` — доменный Account, `Account` — таблица credential провайдера Better Auth; `Organization` отображается в SQL `workspace`. Это имена интеграционного слоя, а не альтернативная модель домена. Owner является отдельным `Member` в единственном workspace. Authorization перечитывает активный Member и Account на каждом запросе, поэтому отключение аккаунта или membership действует сразу.

Стандартный twoFactor plugin выбранной версии хранит secret и backup codes в собственном encrypted представлении; его штатные процедуры не обеспечивают требуемый единый row lock/counter с созданием сессии, AAD `user/state` и хранение recovery codes только как hashes. Поэтому публичные plugin routes закрыты. Узкий `AuthService` использует отдельные `setup_session`, `mfa_credential`, `recovery_code`, а затем создаёт сессию **внутренним adapter Better Auth** внутри той же Prisma-транзакции. `runWithAdapter` явно привязывает async request context Better Auth к транзакционному adapter; интеграционный тест принудительного отказа записи сессии подтверждает rollback потребления TOTP.

Setup token: 256 случайных бит, SHA-256 в БД, TTL 24 часа, singleton lock. Setup cookie: 256 случайных бит, хеш в БД, TTL 15 минут. До подтверждения первого кода существуют только временная запись, Argon2id password hash и encrypted pending secret. Успешный finish атомарно создаёт Account, password credential, workspace, Owner Member, default Team, active MFA, десять recovery hashes и system setting, затем уничтожает bootstrap/setup records. Повторный setup закрыт сервером.

TOTP: 160 случайных бит, шесть цифр, 30 секунд, окно ±1, constant-time comparison. Версия `v1` AES-256-GCM, отдельный 32-байтный ключ в hex, случайный 96-битный nonce, AAD содержит приложение, версию, user ID и `pending`/`active`. Принятый counter монотонно обновляется под `FOR UPDATE` одновременно с сессией или step-up. Один код нельзя использовать для setup, входа и подтверждения повторно. Recovery-код 128-битный, в БД SHA-256, потребление атомарно под тем же credential lock.

Пароли: Argon2id, 64 MiB, time cost 3, parallelism 1; 12–128 символов, небольшой deny-list распространённых паролей. Это не полный breached-password corpus. Auth buckets в PostgreSQL: 10 попыток за 5 минут одновременно по HMAC IP и нормализованного email с типом операции. Реплики используют один `AUTH_RATE_KEY`; исходные identifiers не сохраняются. Очистка накопленных expired auth/setup/session rows требует эксплуатационной задачи перед production.

Cookie `__Host-getexception.session`: Secure, HttpOnly, SameSite=Strict, Path=/, без Domain. Session cache/refresh отключены; абсолютный TTL 8 часов, idle TTL 30 минут. В БД есть `mfaVerifiedAt` и `mfaMethod`; опасные операции требуют `totp` и возраст ≤5 минут. Recovery позволяет войти, но не выдать DSN без нового TOTP. `trustDevice` строго равен `false`; Owner email OTP отсутствует. Signup, invitation и все штатные MFA routes Better Auth не опубликованы. Все изменяющие HTTP-запросы проверяют точный Origin и JSON content type. Setup/status/step-up и ответы auth получают `Cache-Control: no-store`.

Web проверяет ключи и состояние миграций до открытия порта. Audit — append-only для web: только action, success, actor ID и время. Тексты ошибок, secret, пароль и введённые коды в audit не записываются.

## Приём и очередь

Envelope v7: ровно один `event` item, не более 1.25 MiB на HTTP body и 1 MiB на item; заголовок ограничен отдельно. UTF-8 strict, JSON depth 16, максимум 2048 fields, 512 элементов массива, строка 4096 символов. Parser проверяет пределы до создания неограниченной структуры; дубликаты ключей и `__proto__`/`prototype`/`constructor` отклоняются. Compression, multipart, attachments, sessions и performance items отклоняются. Caddy и Node ограничивают body, headers и время чтения.

DSN: 256-битный публичный ключ, SHA-256; UUID проекта; проверка через read-only view активных keys/origins/quota после setup. Точный Origin нужен для браузера; запросы без Origin имеют более низкий лимит и не получают CORS-разрешение. CORS не является аутентификацией клиента: владелец публичного DSN может подделать Origin вне браузера, поэтому квоты обязательны.

Процессный token bucket: IP 10/s, burst 30; без Origin 2/s, burst 5; проект 20/s, burst 50. Не более 20 000 buckets, 200 соединений и 30 исходящих запросов SDK. Точный глобальный rate limit по IP между репликами ingest требует внешнего limiter до production. Общие квоты и backlog уже контролируются атомарно в БД: 100 000/day на установку, по умолчанию 25 000/day на проект, backlog 10 000. Admission trigger под singleton lock присваивает серверный `receivedAt`, не считает duplicate второй раз и выдаёт фиксированный `ingest_capacity`; Prisma P2039/P2004/P2010 преобразуются в HTTP 429. БД недоступна — 503, подтверждения нет.

В inbox попадает только новая каноническая структура allow-list. В ней нет исходного Envelope, raw payload, request, user, extra, произвольных contexts, cookies, headers, storage и исходного URL. Client timestamp ограничен окном; для нагрузки и retention используется серверное время.

Worker claims `FOR UPDATE SKIP LOCKED` в короткой транзакции. Lease 60 секунд, случайный token, максимум 5 attempts, bounded exponential backoff, dead-letter. После вычисления fingerprint транзакция повторно блокирует запись и проверяет token/lease: устаревшая реплика не может завершить чужую задачу. Уникальные `(projectId,eventId)` и `(projectId,fingerprint)` защищают события и группы. Chronology trigger сохраняет min/max времени при завершении задач не по порядку. Этот же trigger выставляет Regression при переходе resolved → open с увеличением счётчика: он видит актуальную заблокированную строку, включая конкурентный Resolve из web. Fingerprint использует тип ошибки и несколько application stack frames, без них — очищенное сообщение. Release и `sourceMapsState=missing` оставляют границу для symbolication.

После успеха inbox payload очищается до `{}`. Retention удаляет события старше 30 суток по 100 и очищает старые dead-letter payload; receipt IDs и агрегаты сохраняются. Concurrency events 1–16, retention один loop в одной реплике. SIGTERM/SIGINT останавливают claim, дожидаются текущей ограниченной обработки и закрывают БД; crash восстанавливается через lease.

## PostgreSQL-роли и миграции

| Роль                   | Права                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getexception_migrate` | Владелец public schema; deploy миграций, без superuser/CREATEDB/CREATEROLE.                                                                                 |
| `getexception_web`     | Auth/settings/projects и серверная проверка Owner; SELECT готовых событий/групп; UPDATE только status/regression группы; audit только SELECT/INSERT.        |
| `getexception_ingest`  | SELECT ограниченных `ingestion_config`, `runtime_schema`; INSERT только четырёх колонок inbox. Нет SELECT inbox, auth, sessions, events, UPDATE/DELETE/DDL. |
| `getexception_worker`  | Inbox claim/update/delete и issue/event/release; без доступа к auth/MFA.                                                                                    |
| `getexception_backup`  | SELECT, без изменения данных/DDL.                                                                                                                           |

Три миграции: Prisma schema, SQL constraints/views/grants/triggers и issue workflow с ограниченными правами изменения статуса. Raw SQL используется в фиксированных параметризованных запросах, где Prisma не выражает row lock/конкурентную операцию; никакой интерполяции недоверенных SQL-фрагментов. SQL миграций статический и проверяется отдельно. Connections явно используют UTC; все временные поля — `timestamptz` (daily buckets — `date`). Это исключает расхождения Prisma adapter и PostgreSQL с локальным timezone.

Для ingest генерируется отдельный **клиентский projection** `ingest.prisma`: только четыре вставляемые колонки и readonly views. Полный Prisma client добавляет defaults в INSERT и нарушает column-level grants. Источник миграций — только `schema.prisma`; **никогда не запускайте migrate по ingest.prisma**.

`runtime_schema` закрывает readiness при незавершённой/неизвестной версии миграций. При следующей миграции обновите ожидаемую версию и проверку view. Текущая версия readiness — 2, ей соответствуют три завершённые миграции. Integration создаёт пустой PostgreSQL, применяет все миграции, а отдельно проверяет последовательное обновление предыдущих схем с существующими данными.

## HTTP и контейнеры

Caddy маршрутизирует разные hosts; dashboard блокирует Envelope, ingest не имеет auth/dashboard routes. Внешние forwarded headers удаляются, `X-Real-IP` задаёт proxy. Прямые runtime-порты не опубликованы. `TRUST_PROXY=1` допустим только за этой закрытой proxy-сетью.

Web/ingest/worker имеют отдельные `/health/live` и `/health/ready`. Ingest readiness проверяет настоящий INSERT в inbox с обязательным rollback. Worker `/metrics` показывает backlog/dead/oldest age только внутри сети; Caddy блокирует health/metrics в интернете. Events и retention используют один image. Runtime работает непривилегированным пользователем, с read-only filesystem, ограничениями памяти/CPU и без capabilities. PostgreSQL и runtime-сети internal; только Caddy имеет edge.

Nonce CSP кабинета не разрешает unsafe-inline scripts, события выводятся обычным React text. URL события не используется для fetch, SQL, команд или HTML. Source maps и другие потенциально тяжёлые/недоверенные преобразования остаются за границей ingest и web.

## Кабинет и issue workflow

Все страницы кабинета требуют действующую сессию и активный Member. Owner видит workspace целиком; Developer/Viewer видят проекты своих команд, включая прямые ссылки на группы и релизы. Members, Audit log и управление доступны только Owner; Resolve/Reopen доступны Owner и Developer. Изменения прав сериализуются блокировкой workspace и отзывают сессии; audit показывает журнал единственной установки, включая неуспешные попытки до входа. Параметры поиска ограничены по длине, enum-фильтры и сортировка используют allow-list, страницы ограничены 200. Счётчики и списки читаются сервером, статические демонстрационные данные отсутствуют.

`POST /api/dashboard/issues/:id/status` принимает только `status: open | resolved` и увиденный пользователем `eventCount`. Доступ проверяется сервером; проверка Origin/JSON, ограничение body и no-store общие с остальным закрытым API. Изменение использует условный UPDATE по счётчику и текущему статусу, audit записывается в той же транзакции. При новом событии старая страница получает 409; повтор той же операции идемпотентен. Web не может менять fingerprint, заголовок, счётчики или payload. Для обычного изменения статуса достаточно активной MFA-сессии; создание проекта по-прежнему требует свежего TOTP.

## Роли и приглашения

[Контракт приглашений и mail worker](mail.md). Owner MFA обязателен; остальные могут включить MFA с паролем и первым TOTP. Включение выдаёт десять recovery codes и отзывает сессии. Отключение добровольного MFA требует пароль и TOTP/recovery, уничтожает credential/recovery и отзывает сессии. Повышение до Owner требует активный MFA; последний активный Owner защищён от отключения и понижения общей блокировкой workspace при параллельных изменениях.
