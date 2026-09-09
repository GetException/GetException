# Уязвимости серверных образов

Исходный отчёт: [Release 34390845921](https://github.com/GetException/GetException/actions/runs/34390845921), Grype 0.118.0, 2026-09-09. Срабатывание по версии компонента не доказывает доступность уязвимого пути в GetException.

## Изменения

| Находки исходного отчёта                         | Исправление в составе образа                                                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 24.4.0, включая CVE-2025-55130              | Node 24.20.0: последняя опубликованная в официальных Docker images ветка Node 24 на момент изменения. Та же версия закреплена в `.nvmrc` и `engines`. |
| GnuTLS: CVE-2026-33845, CVE-2026-42010           | Alpine вместо Debian slim; GnuTLS не входит в выбранную базу.                                                                                         |
| glibc: CVE-2026-5450; пять Critical-находок Perl | musl вместо glibc, Perl отсутствует; исключения сканера не добавлены.                                                                                 |
| OpenSSL: CVE-2026-75803                          | Обновление пакетов Alpine перед сборкой; фактическая версия проверяется в отчёте готового образа.                                                     |
| Старый npm-пакет tar внутри инструментов         | npm, Corepack и глобальный Yarn исключены из конечных образов. Workspace миграций устанавливает только свои production dependencies.                  |
| Nodemailer: GHSA-2x7j-588g-ccc2                  | Обновлён до 9.1.1.                                                                                                                                    |
| Vite 7.3.1                                       | Обновлён до 7.3.6; остаётся инструментом разработки, отсутствует в образе миграций.                                                                   |

Node 24.21.0 уже доступна как отдельный binary, но Docker tag для неё ещё не опубликован; выбран единый доступный runtime для локальной работы и контейнеров. Следующее обновление закрепляет новый digest после проверки его наличия.

## Проверка выпуска

`Release` сканирует все пять готовых образов по digest с `--fail-on critical`. Ошибка сканера или критическая находка блокирует публикацию установщика. Полные JSON-отчёты доступны в artifacts `vulnerabilities-<target>`, включая неуспешные запуски. Снижение порога, скрытие найденных пакетов из каталога сканера и глобальное игнорирование неисправленных CVE не используются.

Обновление состава образов само по себе не является успешным результатом сканирования: завершённую проверку нужно смотреть в `Release` для конкретного SHA. `yarn checks` проверяет приложение, миграции и workflows; Linux CI дополнительно проверяет настоящие контейнеры, Owner/TOTP, приём событий, сохранение данных и восстановление backup.

PostgreSQL и Caddy — отдельные upstream-образы в Compose; матрица этих пяти отчётов их не охватывает. Их версии и безопасность также нужно проверять при обновлении инфраструктуры; этот отчёт не утверждает отсутствие уязвимостей во всём сервере.

Источники: [исправления Node.js](https://nodejs.org/en/blog/vulnerability/december-2025-security-releases), [официальные теги Node Docker](https://github.com/docker-library/official-images/blob/master/library/node), [glibc в Debian](https://security-tracker.debian.org/tracker/CVE-2026-5450), [Perl в Debian](https://security-tracker.debian.org/tracker/CVE-2026-8376), [OpenSSL](https://security-tracker.debian.org/tracker/CVE-2026-75803), [Nodemailer 9.1.1](https://github.com/nodemailer/nodemailer/releases/tag/v9.1.1), [Prisma Docker](https://www.prisma.io/docs/guides/deployment/docker), [Argon2 Alpine](https://github.com/ranisalt/node-argon2#prebuilt-binaries).
