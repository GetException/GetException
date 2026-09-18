# Прямая доставка source maps из GitLab

Сборка отправляет карты по HTTPS непосредственно в GetException. GitLab выдаёт job короткоживущее подписанное удостоверение; постоянный токен GetException или GitLab API token для MR не нужен. Удостоверение подтверждает проект и коммит, но не доказывает корректность кода сборки. Карты в браузер, GitLab artifacts, cache, логи и отчёты не включаются.

## Однократная настройка GetException

Интеграция выключена, пока оператор сервера не задаст `GITLAB_CI_TRUST`. Нужны UUID проекта GetException, числовой Project ID и путь репозитория GitLab. Это не секреты. Обычному MR не разрешено создавать или менять доверие.

Из checkout GetException с установленными зависимостями:

```bash
yarn ci:gitlab-config \
  --gitlab https://gitlab.example.com \
  --project 11111111-1111-4111-8111-111111111111 \
  --repository-id 123 \
  --repository-path company/frontend/account \
  --release-prefix account \
  --production-environment production/app \
  --production-ref refs/heads/stable \
  --production-ref 'refs/tags/v*' \
  --output /tmp/getexception-gitlab-trust.json
```

Команда читает только публичные OIDC metadata/JWKS по проверенному HTTPS, не следует redirect и не использует API token. Проверяет, что issuer и адрес ключей принадлежат указанному GitLab. В некоторых self-hosted установках issuer — строка `http://…` за HTTPS proxy: сохраняется точный идентификатор, но все сетевые запросы остаются HTTPS. Публичные ключи не дают возможности подписывать удостоверения.

Проверить привязку проекта в созданном JSON, затем записать его **одной строкой** в `GITLAB_CI_TRUST` файла `/opt/getexception/runtime/.env`. Controller требует формат `KEY="value"` с JSON escaping; вложенные кавычки JSON необходимо экранировать, а `$` удваивать, как описано в [руководстве установки](deployment.md). Одинарные кавычки не поддерживаются. Это операторская конфигурация: права записи должны оставаться только у оператора. Применить её обычной командой `/opt/getexception/getexception update --release FULL_RELEASE_SHA`, указав проверенный выпуск с поддержкой OIDC. Копировать JSON в account, браузер или переменные MR не нужно.

Compose передаёт настройку только web. Другие сервисы её не получают, сети web/worker остаются internal. Web проверяет подпись локально через `jose`; не загружает URL из удостоверения и не обращается к GitLab. Для дополнительного проекта добавить отдельную проверенную запись `projects`; UUID GetException не должен повторяться.

При ротации signing keys GitLab оператор повторно получает публичные ключи через ту же HTTPS-процедуру, сохраняет все актуальные привязки и обновляет конфигурацию web. Неизвестный ключ приводит к отказу, а не переходу к другому виду авторизации. Удаление привязки отключает новые операции OIDC после обновления конфигурации. Старые source maps сохраняются по обычной retention-политике.

## Настройки Owner и форки

В `Projects → <проект> → Settings → Source maps` Owner выбирает **Production only** либо **Production and MR**. По умолчанию действует Production only, включая существующие проекты после обновления. Список **Allowed forks** содержит числовой Project ID и полный путь каждого разрешённого источника (`developer/account`). Основной репозиторий уже включён и отдельно в список не добавляется. Можно сохранить до 20 форков; wildcard и повторяющиеся ID/path запрещены. Все MR из перечисленного форка получают одинаковое ограниченное разрешение — оно не привязано к личности автора.

Изменение требует входа Owner и свежего подтверждения личности; записывается в audit log. После сохранения новая настройка применяется к каждому следующему запросу без перезапуска контейнеров. Production only сохраняет список форков, но выключает карты **всех** preview этого проекта. Ранее загруженные карты не удаляются, приём событий не выключается. Замена issuer/основного репозитория/release prefix в операторской конфигурации требует повторного сохранения разрешений Owner.

GitLab различает источник кода и проект, где выполняется job. Для MR разрешённого форка поддерживается выполнение в самом форке и в основном проекте. Это не даёт права production: там по-прежнему допустим только основной репозиторий с заданными protected refs. Проверка выполняется по подписанным данным GitLab, не по ID, присланному управляющим скриптом.

Owner доверяет preview job источника, а не утверждению о target MR: ID token не удостоверяет target MR, и номер в environment остаётся меткой. Автоматического доступа для любых форков нет. Не переносить production secrets в fork pipelines ради этой интеграции.

## Настройка сборки account

Использовать сервер и `@getexception/cli` с контрактом `ci context` **version 2**. CLI 0.1.8 поддерживает только предыдущий контракт и требует обновления; 0.1.7 не имеет команды. SDK менять ради авторизации CI не требуется. Сначала выпустить сервер и CLI, затем обновлять интеграцию account. Старый клиент не должен интерпретировать неизвестный ответ как разрешение.

Новый CLI запрашивает `POST /api/v1/projects/{id}/ci?version=2`. Без этого параметра сервер сохраняет старый ответ из трёх полей только для сборок с разрешёнными картами. Если карты запрещены, старый клиент получает 403, а не неявный skip. Поэтому обновление сервера не ломает разрешённые production-сборки с CLI 0.1.8, но для переключателя и форков account нужен новый CLI. Другие значения version отвергаются.

Добавить **только в app job**:

```yaml
timeout: 50m
id_tokens:
  GETEXCEPTION_GITLAB_ID_TOKEN:
    aud: https://monitor.example.com
environment:
  name: review/pr-$CI_MERGE_REQUEST_IID
```

Удостоверение создаёт GitLab; одноимённую постоянную переменную создавать нельзя. Audience — точный HTTPS origin GetException. Токен доступен только управляющему коду доставки: удалить его и `GETEXCEPTION_UPLOAD_TOKEN` из окружения `yarn install`, компилятора приложения и сторонних команд. Не передавать в argv, `APP_*`, `VITE_*`, build output или логи. Для MR не включать доступ к protected variables.

До сборки управляющий скрипт вызывает:

```bash
yarn getexception ci context --url https://monitor.example.com --project <UUID>
```

Успешный ответ — JSON без токена:

```json
{
  "version": 2,
  "sourceMaps": { "enabled": true },
  "release": "account@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "assetPrefix": "assets/ge-gl-123-456/",
  "deployment": {
    "environment": "staging",
    "review": { "provider": "gitlab", "repositoryId": 123, "number": 554 }
  }
}
```

Здесь 123 — **основной** GitLab project ID, 456 — job ID. При сборке форка префикс и `deployment.review.repositoryId` по-прежнему относятся к основной привязке; source repository ID не заменяет этот ID. Управляющий скрипт сверяет release с собственным `CI_COMMIT_SHA`, задаёт этот release SDK и использует **ровно этот префикс** для всех JS chunks, включая entry и dynamic imports. Не добавлять prefix только в manifest: реальные URL файлов и карты должны совпадать. Для имеющегося Vite namespace account значение namespace — `gl-123-456`, поскольку конфигурация уже добавляет `assets/ge-`.

Два явных ответа без загрузки:

- Доверенный источник при Production only: тот же контекст `version/release/assetPrefix/deployment`, но `sourceMaps: {"enabled":false,"reason":"preview_disabled"}`. Собирать с `sourcemap:false`, не выполнять prepare/upload, продолжить preview. После успешного deploy можно зарегистрировать возвращённый release/deployment.
- Источник не входит в allowlist: только `{"version":2,"sourceMaps":{"enabled":false,"reason":"source_not_allowed"}}`, **без** release/assetPrefix/deployment. Собирать обычный preview без карт; SDK сохраняет собственный `account@CI_COMMIT_SHA` и staging. Не вызывать upload или регистрацию release, не изобретать разрешённый контекст. Публичные события по DSN по-прежнему принимаются согласно origins и лимитам проекта.

Оба ответа успешны только для корректно подписанного поддерживаемого preview-контекста. Ошибки 401/403/5xx, timeout, неизвестная версия или невалидный JSON — не skip и не повод автоматически отключать карты. Production не получает skip; неожиданный skip в production считать ошибкой интеграции. Режим production-only нельзя обойти постоянным upload token.

После сборки выполнить существующую подготовку карт один раз, затем загрузить все batches тем же удостоверением. Ограничения 128 карт/128 MiB на batch остаются; разбиение account на batches сохраняется. CLI использует `Authorization: GitLab <ID token>`. Одновременное наличие `GETEXCEPTION_UPLOAD_TOKEN` и `GETEXCEPTION_GITLAB_ID_TOKEN` — ошибка; автоматического fallback нет.

Для MR с включёнными картами дождаться `ready` всех batches, затем deploy подготовленного JS. Во **всех** режимах проверить отсутствие `.map`, `.map.gz`, `.map.br`, inline source maps и приватных каталогов в публичной сборке. Зарегистрировать release с `deployment` из ответа `ci context` после успешного deploy только если сервер вернул этот контекст. При ошибке авторизации/upload не выдавать успешный статус нового preview; предыдущий preview продолжает работать. Если Owner отключил доступ после начала сборки, дальнейшие операции получают отказ — pipeline нужно перезапустить, чтобы получить новое решение до сборки.

Production разрешён только при одновременном совпадении конфигурации environment/ref, подписанного `ref_protected` и pipeline source push/web. Секреты production по-прежнему не передаются MR. При аварии мониторинга политика срочного production deploy может сохранить выпуск без карт с явным предупреждением; открытая копия карт в artifacts/cache не является допустимым fallback.

Карты и промежуточные копии существуют только в рабочем каталоге текущего изолированного job до его завершения. Для MR **удалить `.getexception-maps/` из `artifacts.paths`**, сохранить только нужные preview metadata. Для production убрать блок artifacts, если карты были его единственным содержимым. Не добавлять карты в dotenv reports, общий cache или Turbo cache. Сборка app остаётся с `cache: false`; вспомогательные задания не должны скачивать карты через `needs:artifacts`.

Сбой после истечения удостоверения или завершения job требует нового запуска build/deploy с новым job ID. Новая сборка получает новый префикс и свои карты. Она не восстанавливает потерянные карты прежней сборки. Повторы upload внутри ещё действующего job используют прежние подготовленные байты. Истёкшие credentials не продлеваются сервером.

## Что проверяет сервер

- RS256, закреплённый issuer/kid, единственный audience, exp/iat/nbf, jti/sub, срок до часа.
- Точные GitLab project ID/path источника; согласованную пару job project ID/path, когда GitLab её предоставляет. Форк допускается только для MR, в своём или основном проекте, с разрешением Owner. Неполная пара execution claims отвергается.
- SHA и привязка `.gitlab-ci.yml` к source repo/ref. Исключение GitLab для fork MR в основном проекте: оба config claims могут быть null, если подписаны точные job project ID/path основного проекта. Отсутствие execution claims вместе с null config, частичные null, внешний config и несовпадающий SHA отвергаются. Merged-result pipelines отдельно не поддерживаются.
- Только ожидаемые environments и pipeline sources; MR никогда не получает production.
- Каждая операция begin/PUT/finalize/status ограничена release и префиксом текущего job, включая retry и старые upload IDs.
- Регистрация окружения/номера MR совпадает с контекстом сервера. Номер MR из `review/pr-N` — подписанная метка job, но автор MR может менять свой YAML; это не доказательство успешного review или deploy.
- Путь кадра совпадает с картой даже при наличии Debug ID. MR не может подменить source map другого пути/сборки.

Старый `Bearer` остаётся только у проектов без GitLab-привязки. В проектах с этой привязкой он отвергается: он не подтверждает окружение и позволил бы обойти Owner policy. Публичный DSN, cookie и OIDC не взаимозаменяемы. Ни один CI credential не открывает raw download карт, события или настройки проекта.

## Приёмка и существующие архивы

Локальные тесты проверяют реальные подписи, PostgreSQL, загрузку и symbolication, подмену проекта/SHA/job/environment, истечение и отсутствие internet fetch. Они не доказывают работоспособность конкретного GitLab pipeline. После выпуска сервера и CLI требуется один реальный app pipeline MR, затем ошибка **из файла приложения**, а не DevTools: исходный `.tsx`, строка и контекст должны появиться в GetException.

Новые изменения не удаляют уже сохранённые GitLab artifacts. Нужна отдельная точечная проверка/очистка имеющим права участником; не удалять все pipelines/логи или посторонние файлы. Пока права не проверены, нельзя обещать, что прошлые архивы доступны только владельцам исходников. Проверенные публичные URLs и фактические настройки доступа нужно описывать отдельно.

Источники: [GitLab ID tokens](https://docs.gitlab.com/ci/secrets/id_token_authentication/), [локальная проверка JWT в jose](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md).
