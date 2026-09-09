# Зависимости и выбранные границы

Версии прямых зависимостей закреплены в package manifests и `yarn.lock`, lock меняется только Yarn. Диапазон React в peerDependencies SDK — контракт совместимости потребителя, не плавающая версия сборки; dev/runtime React закреплён отдельно. Prisma-generated clients и build outputs в Git не добавляются.

| Зависимость                                                                         | Зачем нужна                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 24.20.0 / Yarn 4.17.1                                                          | Единый runtime/toolchain, workspaces и обычный node_modules.                                                                                                      |
| Next.js 16.3.4, React/React DOM 19.2.8                                              | App Router, серверный rendering и интерактивные auth/project формы.                                                                                               |
| Base UI 1.8.0                                                                       | Доступные Input/Field/Button primitives без собственной реализации управления фокусом и label.                                                                    |
| Tailwind/PostCSS 4.3.3                                                              | Стили и семантические CSS variables, без внешнего CDN.                                                                                                            |
| Better Auth / core 1.6.23                                                           | Identity, credential adapter, sessions, secure signed cookies и узкая интеграция transaction context.                                                             |
| Better Auth core peers (utils, better-fetch, better-call, jose, kysely, nanostores) | Явно закреплены уже используемые runtime peers core, чтобы транзакционная интеграция не зависела от hoisting транзитивных зависимостей.                           |
| Argon2 0.44.0                                                                       | Argon2id passwords. Эта версия имеет проверенный native prebuild для текущего Darwin x64; параметры задаёт сервер.                                                |
| Prisma/client/adapter-pg 7.10.0, pg 8.23.1                                          | Модель, миграции и отдельные PostgreSQL clients с SQL permissions; фиксированные параметризованные locks.                                                         |
| Zod 4.5.4                                                                           | Строгие schemas после bounded parsing, проверка config и построение безопасного события.                                                                          |
| Sentry browser/react 10.73.0                                                        | Официальный stack parser, global error capture и React ErrorBoundary. Ненужные integrations выключены, transport заменён.                                         |
| TypeScript 5.9.3, ESLint, Prettier                                                  | Строгая типизация, AST architecture check, lint и форматирование.                                                                                                 |
| tsup 8.5.1, tsx 4.23.13, Vite 7.3.6                                                 | ESM bundles и declarations, локальные scripts, реальные SPA fixtures.                                                                                             |
| Vitest 5.0.0                                                                        | Unit и интеграционные тесты с настоящим PostgreSQL.                                                                                                               |
| embedded-postgres 17.9.0-beta.16                                                    | Только dev/test: локальный изолированный PostgreSQL без установки Docker. Platform binary закреплён lockfile. Production использует официальный PostgreSQL image. |
| Playwright 1.63.0                                                                   | Полный browser scenario через HTTPS, проверка cookies, SDK и dashboard.                                                                                           |
| Caddy 2.10.2                                                                        | Разные HTTPS hosts, локальная CA, маршрутизация и HTTP границы. Stock Caddy не заменяет распределённый rate limiter.                                              |

API интеграции проверялся по исходникам фактически установленных версий, в частности Better Auth adapter context, cookie creation, twoFactor storage и Prisma PostgreSQL adapter. Интеграционные тесты фиксируют предположения, которые нельзя заменить одной ссылкой на документацию: атомарность сессии/MFA, UTC timestamps и отказ column-level grants у полного ingest client.

Обновление Better Auth, Prisma или Sentry требует повторить integration, alias и HTTPS E2E. Перед production отдельно проверить advisories, доступность/происхождение pinned images, обновить поддерживаемые patch versions и закрепить digests. Публикация SDK и передача NPM_TOKEN этой итерацией не выполняются.

Почта, Mailpit и обновление локальной конфигурации: [mail.md](mail.md).

## Инструменты release checks

`yarn ci:tools` устанавливает actionlint 1.7.12 и gitleaks 8.30.1 в игнорируемый `.artifacts/tools`. Grype 0.118.0 устанавливается только в job сканирования образов. Версии и SHA256 официальных архивов закреплены в `scripts/release/tools.json`; перед извлечением проверяется checksum. Эти бинарники не входят в npm packages или runtime images.

Проверка лицензий читает установленные manifests, включая платформенные native dependencies, и останавливается на неизвестной лицензии. В allow-list перечислены используемые permissive лицензии, MPL-2.0 (lightningcss/вендор Next), EPL-2.0 (elkjs), LGPL-3.0-or-later (неизменённые native libvips) и CC-BY-4.0 (caniuse-lite). Notices и LICENSE зависимостей сохраняются в `node_modules` внутри образов. `seq-queue@0.0.5` не указывает license в manifest; проверяется MIT-текст его LICENSE. Это техническая проверка состава зависимостей; новые лицензии требуют отдельного review.
