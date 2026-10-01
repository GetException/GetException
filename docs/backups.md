# Зашифрованные внешние резервные копии

На 1 октября 2026 внешнего хранилища у установки ещё нет. Код и systemd-шаблоны подготовлены; ежедневный backup нельзя считать настроенным до успешной загрузки, проверки прав bucket и восстановления скачанного объекта.

## Состав и границы

`deploy/backup.py create` делает согласованный `pg_dump -Fc` ролью `getexception_backup`, добавляет runtime-конфигурацию с ключом TOTP и метаданные версии. Архив шифруется age X25519 до отправки. На сервере находится только публичный recipient, приватный identity хранится отдельно у оператора. S3 credentials в архив не включаются: это отдельный файл, а не переменные runtime `.env`.

Файлы source maps в архив не входят. Уже восстановленные строки сохраняются в событиях PostgreSQL. Для новых событий карты можно загрузить повторно из доверенной сборки того же commit с теми же зависимостями. Сохранение карт в CI artifacts запрещено действующим контрактом интеграции; если воспроизводимая пересборка невозможна, старые карты могут быть потеряны.

Лимит одного зашифрованного объекта — 5 GiB. Дамп ограничен при записи и свободным местом: остаётся резерв 5 GiB, учитываются временные копии архива. Превышение лимита, нехватка места, ошибка шифрования или upload завершают команду ошибкой. Успех записывается в `runtime/backup-status.json` только после принятия объекта хранилищем. После успеха временные файлы удаляются; при ошибке отправки остаётся только зашифрованный архив для расследования. Локальные `.dump` перед обновлением управляются отдельно и не заменяют внешний backup.

## Подготовка хранилища

Нужен закрытый bucket с versioning, TLS, поддержкой `If-None-Match: *` и SHA-256 checksum. Включите Object Lock, если провайдер его поддерживает. Writer получает только `PutObject` в отдельном prefix: без чтения, listing, удаления и изменения bucket policy. Bucket policy должна запрещать запись без условия отсутствия объекта. Для восстановления нужен отдельный read credential, отсутствующий на production-сервере. [Условия записи S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html), [AWS CLI PutObject](https://docs.aws.amazon.com/cli/latest/reference/s3api/put-object.html).

До подключения проверьте этими credentials: новый объект записывается; повторная запись того же имени, чтение, удаление и listing запрещены. Upload использует случайное имя, `--if-none-match '*'` и проверяемый хранилищем SHA-256. Несовместимый провайдер должен отказать; отключать эти проверки для совместимости нельзя.

Сохраняйте три последние **успешные** копии внешним механизмом retention с отдельными полномочиями. Обычное удаление всех объектов старше трёх дней не гарантирует этого при пропусках backup. Настройка retention и оповещение об отсутствии свежей копии более 30 часов относятся к обязательной настройке выбранного хранилища. Production writer не получает права удаления ради retention.

## Ключи и конфигурация

На отдельном доверенном компьютере установите проверенный [age](https://github.com/FiloSottile/age), создайте identity и сохраните его в двух защищённых местах:

```bash
umask 077
age-keygen --output getexception-backup-identity.txt
age-keygen -y getexception-backup-identity.txt
```

На сервере нужны age и AWS CLI v2 с поддержкой conditional PutObject. Для age 1.3.2 закреплены SHA-256 официальных архивов в `scripts/release/tools.json`; `python3 scripts/release/install-tools.py age` проверяет их перед установкой в `.artifacts/tools`. Production systemd должен видеть проверенные бинарники в своём PATH. Приватный identity на сервер не копируйте.

Создайте `/opt/getexception/runtime/backup-writer.credentials` с единственным профилем `[default]` для write-only credential и правами `0600`. Значения вводятся локально; не добавляйте файл в Git. В `/opt/getexception/runtime/backup.json` с правами `0600` укажите:

```json
{
  "recipient": "PUBLIC_RECIPIENT_FROM_AGE_KEYGEN",
  "bucket": "PRIVATE_BUCKET_NAME",
  "prefix": "getexception/daily/",
  "region": "PROVIDER_REGION",
  "credentialsFile": "/opt/getexception/runtime/backup-writer.credentials",
  "endpoint": "https://S3_ENDPOINT"
}
```

Для AWS поле `endpoint` удалите. Замените placeholders; реальные пути и настройки проверяются до создания дампа. Файлы должны принадлежать пользователю, запускающему backup. Используется общий installer lock: backup не пересекается с миграцией или обновлением.

## Первый запуск и расписание

```bash
sudo python3 /opt/getexception/current/backup.py create --install-dir /opt/getexception
```

После проверки скачанного объекта и восстановления установите шаблоны:

```bash
sudo install -m 0644 /opt/getexception/current/getexception-backup.service /etc/systemd/system/
sudo install -m 0644 /opt/getexception/current/getexception-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now getexception-backup.timer
sudo systemctl list-timers getexception-backup.timer
```

По умолчанию запуск ежедневный в 03:00 UTC с разбросом до 15 минут. Для другого install path измените `ExecStart` перед установкой unit. `systemctl status getexception-backup.service`, journal и `runtime/backup-status.json` позволяют проверить результат; внешнее оповещение о просроченной копии нужно подключить отдельно.

## Проверка восстановления

1. На отдельном компьютере скачайте объект с отдельным read credential. Сверьте его SHA-256 с receipt. Не используйте production writer для чтения.
2. Запустите `python3 backup.py unpack --file backup.tar.age --identity /secure/getexception-backup-identity.txt --output /secure/new-restore-directory`. Команда требует новый каталог, проверяет полный age authentication tag, ограниченный состав tar и SHA-256 дампа/конфигурации. При повреждении или неверном identity готовый каталог не появляется.
3. На изолированном recovery host подготовьте PostgreSQL 17 и роли из `init-db.sh` **того же проверенного релиза**, указанного в восстановленном `release.json`. Секреты ролей берутся из восстановленного `runtime.env`. Запустите только PostgreSQL; приложения и migrate пока не запускайте.
4. Убедитесь, что целевая база пуста. Проверьте `pg_restore --list database.dump`, затем выполните `pg_restore --exit-on-error -U postgres -d EMPTY_DATABASE database.dump`. Не используйте `--clean` поверх рабочей базы. Роли и grants из дампа должны сохраниться.
5. Сверьте количество аккаунтов, участников, проектов, событий, schema version и отсутствие незавершённой миграции. Подключите восстановленные TOTP/session keys, запустите приложения того же SHA в изолированной сети и проверьте вход с существующим TOTP/recovery-кодом и доступ по ролям. Не направляйте туда production DNS/SDK до завершения проверки.
6. Запишите дату, object key, SHA-256, release SHA и результат. Удалите временную восстановленную установку после проверки. Приватный identity и read credential храните отдельно.

CI проверяет реальный age roundtrip, отказ при повреждении/чужом ключе, ограничения архива и восстановление зашифрованного PostgreSQL dump в пустую тестовую БД. Это не заменяет первую проверку скачивания и восстановления из выбранного внешнего хранилища.
