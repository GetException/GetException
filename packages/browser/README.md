# @getexception/browser

Browser error monitoring for your own GetException server. Captures unhandled exceptions and promise rejections, and provides a small API for reporting handled errors.

## Install

```bash
yarn add --exact @getexception/browser
```

For React applications, install [`@getexception/react`](https://www.npmjs.com/package/@getexception/react) instead; it includes the browser SDK and a React `ErrorBoundary`.

## Initialize

Create a project in GetException, configure its **Allowed origins**, and save the DSN. Initialize once in the browser entry point. With Vite:

```ts
import * as GetException from "@getexception/browser";

GetException.init({
  dsn: import.meta.env.VITE_GETEXCEPTION_DSN,
  environment: "production",
});

GetException.captureException(new Error("GetException connection test"));
```

Use your installation's separate HTTPS ingest domain in the DSN. It must resolve and have a valid certificate before errors can reach the server. Add the ingest origin to CSP `connect-src` if your application uses CSP. The DSN is a public, write-only project key and does not grant access to the dashboard.

## Configuration

| Option        | Meaning                                                               |
| ------------- | --------------------------------------------------------------------- |
| `dsn`         | Required HTTPS project DSN from GetException.                         |
| `environment` | `production`, `staging` or `development` (default).                   |
| `release`     | Optional `<project-slug>@<full 40-character Git SHA>`.                |
| `dist`        | Optional build identifier, up to 64 letters, digits, `.`, `_` or `-`. |
| `enabled`     | Set to `false` to skip initialization.                                |

Importing the package does not initialize monitoring. Invalid configuration disables sending without throwing into the application. Calling `init` again while the client is active does nothing; use `close` before initializing another client.

## Manual capture and context

```ts
GetException.withScope((scope) => {
  scope.setTag("feature", "editor");
  scope.setTag("operation", "save");
  scope.setContext("app", { route: "/documents" });
  GetException.captureException(new Error("Document save failed"));
});

GetException.captureMessage("Upload failed", "error");
await GetException.flush(1500);
```

`captureException` and `captureMessage` return an event ID, or an empty string when inactive. An event ID does not confirm delivery. `captureMessage` supports only `error` and `fatal`. `flush` waits for local work to finish; it does not guarantee acceptance or processing by the server. `close` shuts down the client. Both return `Promise<boolean>` and cap waiting at two seconds.

Tags are limited to `feature`, `component` and `operation`. Context is limited to `app.route`, with query strings and fragments removed. Manual breadcrumbs support `navigation`, `http` and `manual` with allowed fields only. See the [compatibility guide](https://github.com/GetException/GetException/blob/stable/docs/sdk-compatibility.md) before replacing Sentry imports through npm aliases.

## Privacy and scope

The client uses a restricted Sentry integration and cleans event data before sending. The server independently validates and cleans it again. Requests omit cookies and referrers. Network failures do not throw into your application; the client limits pending requests and backs off after HTTP 429.

No replay, tracing, user identity, automatic console/DOM breadcrumbs, cookies, form data, local storage, attachments or arbitrary context are collected. Avoid putting credentials or personal data in error messages. Source map upload and symbolication are not yet implemented.

This package targets modern browsers, is ESM and includes TypeScript declarations. It is not a Node.js SDK.

## License

MIT. See `THIRD-PARTY-NOTICES.md` for the underlying Sentry SDK and bundled dependencies.
