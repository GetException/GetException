# Совместимость SDK 0.1.0

Основа — официальные `@sentry/browser` и `@sentry/react` **10.73.0**. Зависимости установлены под внутренними npm alias `@getexception/sentry-browser` и `@getexception/sentry-react`, чтобы пользовательский alias Sentry → GetException не создавал рекурсию. Import не вызывает `init`, не подключает обработчики и ничего не отправляет. Внутренняя конфигурация Sentry использует технический числовой project ID: его validator не принимает UUID с буквенным префиксом. Собственный transport всегда отправляет по исходному UUID из DSN, а внутренний DSN не попадает в Envelope. Это проверяется отдельно с настоящим SDK.

| API                                  | Поддержка и отличие                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init(options)`                      | Только `dsn`, `release`, `dist`, `environment`, `enabled`. HTTPS обязателен; неверный DSN отключает отправку без исключения в SPA. Повторный `init` при активном клиенте ничего не меняет. |
| `captureException(error)`            | Официальный разбор Error и stack; возвращает event ID или пустую строку, если SDK не активен/не смог принять вызов. Hint/attachments не поддерживаются.                                    |
| `captureMessage(message, level)`     | Только `error` и `fatal`, по умолчанию `error`. Другие уровни запрещены типами и дают пустой ID без отправки при вызове из JS.                                                             |
| `setTag`, `setTags`                  | `feature`, `component`, `operation`, до 120 символов, очистка значений. Остальные ключи удаляются. Owner UI настройки allow-list ещё нет.                                                  |
| `setContext(name, value)`            | Только `app: { route }`. URL превращается в очищенный path без origin, query и fragment.                                                                                                   |
| `addBreadcrumb`                      | Только `navigation`, `http`, `manual`; безопасные `path`, `method`, `status_code`, `duration`, `operation`. Максимум 50. Console, DOM и произвольные data не собираются.                   |
| `withScope(callback)`                | Синхронный scoped callback с перечисленными setters. Callback вызывается и до init; его собственные исключения сохраняют обычное поведение приложения. Async isolation scope не обещается. |
| `flush(timeout)`, `close(timeout)`   | `Promise<boolean>`, по умолчанию 1500 мс, максимум 2000 мс. Close завершает отправку и прерывает оставшиеся запросы.                                                                       |
| `window.error`, `unhandledrejection` | Через официальные global handlers / browser API errors integrations после init.                                                                                                            |
| `ErrorBoundary`                      | Экспорт официального React ErrorBoundary; проверен с React 19.2.8. Сбор ошибок начинается после init. Собственный fallback задаёт приложение.                                              |

Не экспортируются `setUser`, tracing, replay, profiling, feedback, logs, router integrations, пользовательский transport/integrations, global processors и настройки Sentry, расширяющие сбор данных. TypeScript отклоняет эти импорты/опции. Перед миграцией удалите неподдерживаемые вызовы; простая замена имени пакета не делает весь API Sentry совместимым.

```ts
import * as GetException from "@getexception/browser";

GetException.init({
  dsn: import.meta.env.VITE_GETEXCEPTION_DSN,
  environment: "production",
  release: "customer-portal@0123456789abcdef0123456789abcdef01234567",
});
GetException.setTag("feature", "checkout");
GetException.setContext("app", { route: "/checkout" });
GetException.captureException(new Error("Checkout failed"));
```

`release` принимает `<project-slug>@<40-символьный git SHA>`. Release хранит `sourceMapsState=missing`, frame может сохранить `debug_id`. Это граница будущей загрузки source maps; сервер сейчас не загружает URL и не символицирует stack.

## Миграция через npm alias

После будущей публикации пакетов зависимости приложения могут выглядеть так:

```json
{
  "dependencies": {
    "@sentry/browser": "npm:@getexception/browser@0.1.0",
    "@sentry/react": "npm:@getexception/react@0.1.0"
  }
}
```

Импорты поддерживаемого API остаются `@sentry/browser` / `@sentry/react`. Пакеты в этой итерации **не опубликованы**. `yarn test:alias` упаковывает реальные SDK, поднимает временный локальный registry, устанавливает именно npm alias в отдельном проекте, повторяет immutable install и проверяет runtime exports и TypeScript-контракт. Тест не требует публикации или NPM_TOKEN.

## Transport и приватность

`fetch` использует только HTTPS origin из DSN, `credentials: "omit"`, `referrerPolicy: "no-referrer"`, `redirect: "error"`. Очередь ограничена 30 запросами, запрос — двумя секундами. `429` включает ограниченный backoff; сетевые ошибки не выбрасываются в SPA. Поддерживается один error item в Envelope. Данные очищаются перед отправкой и независимо повторно на ingest.

Автоматические breadcrumbs, IP, cookies, headers, request body, form values, local/session storage, arbitrary contexts, extra, user и локальные переменные stack не отправляются. Санитайзер удаляет распространённые токены, email и секреты в разрешённых строках. Необычно закодированные секреты в тексте ошибки невозможно гарантированно распознать: приложение не должно помещать их в message, tags или ручные breadcrumbs.
