# Следующая минимальная итерация

Первый шаг — подключить подготовленный release pipeline к GitHub, пройти Linux Docker/registry/bootstrap jobs и развернуть проверенный релиз на сервере по [инструкции](deployment.md). Installer, update/rollback, image digests и серверный TLS подготовлены; реальные SSH, DNS, SMTP и permissions пока не настраивались. Затем проверить прекращение worker во время lease, восстановление внешнего backup и нагрузку до квоты/backlog. Добавить bounded cleanup истёкших auth/setup/session buckets, receipt compaction, реальный rejected counter и проверенный общий edge rate limiter. Подготовить процедуру хранения/ротации ключей; для сервера используется отдельный `deploy/compose.yaml`.

Реализованы команды, управление Member, приглашения Developer/Viewer, серверный доступ по командам, отдельный SMTP worker и локальный Mailpit. Дополнительный Owner назначается существующим Owner после включения MFA участником. Последний активный Owner защищён от отключения и понижения. Ручная приёмка: [сценарий](manual-testing-members.md).

Следующий функциональный шаг — восстановление доступа: password reset участников и утверждённые процедуры MFA/offline Owner recovery. Затем ротация DSN и подключение sourcemaps.

CLI/source map upload станет отдельным закрытым API, symbolication будет выполняться worker с изоляцией и переобработкой release. Затем — уведомления. Защищённая публикация SDK уже включена в подготовленный release workflow. Эти модули пока не содержат заглушек, обещающих готовое поведение.
