# @getexception/react

Error monitoring for React 18 and 19 applications using your own GetException server. Includes automatic browser error capture, manual capture and a React `ErrorBoundary`.

## Install

```bash
yarn add --exact @getexception/react
```

The browser SDK is installed automatically. This package is for browser applications; it does not provide a Node.js or Next.js server SDK.

## Connect your application

Create a project in the GetException dashboard, add your application's origin to **Allowed origins**, and save the DSN shown when the project is created. The DSN must use the installation's separate HTTPS ingest domain.

Initialize once in your application entry point, before rendering React. With Vite:

```tsx
import { createRoot } from "react-dom/client";
import * as GetException from "@getexception/react";
import { App } from "./App";

GetException.init({
  dsn: import.meta.env.VITE_GETEXCEPTION_DSN,
  environment: "production",
});

createRoot(document.getElementById("root")!).render(
  <GetException.ErrorBoundary fallback={<p>Something went wrong.</p>}>
    <App />
  </GetException.ErrorBoundary>,
);
```

Put the DSN in your application's environment configuration. It is a public, write-only project key, not a dashboard password. If your application uses a Content Security Policy, allow the ingest origin in `connect-src`.

`ErrorBoundary` captures errors while rendering its children and shows your fallback. Unhandled browser errors and promise rejections are captured after `init`. For errors handled by your own code:

```ts
try {
  await saveDocument();
} catch (error) {
  GetException.captureException(error);
}
```

To check the connection, call `GetException.captureException(new Error("GetException connection test"))` and look for the issue in your project. The ingest domain must resolve and have a valid HTTPS certificate. Local SDK tests do not require your production ingest DNS.

## Supported API

`init`, `captureException`, `captureMessage`, `setTag`, `setTags`, `setContext`, `addBreadcrumb`, `withScope`, `flush`, `close`, and `ErrorBoundary`. See the [browser SDK](https://www.npmjs.com/package/@getexception/browser) for configuration and the [compatibility guide](https://github.com/GetException/GetException/blob/stable/docs/sdk-compatibility.md) for exact limits.

The SDK uses a restricted Sentry integration. It sends errors only: no replay, tracing, automatic console/DOM breadcrumbs, cookies, form values or user identity. Tags and context use an allow-list. Source map upload and symbolication are not yet implemented, so production stack traces may refer to bundled code.

React is a peer dependency and stays under the application's control. Importing the package does not start monitoring; call `init` explicitly. The package is ESM and includes TypeScript declarations.

## License

MIT. See `THIRD-PARTY-NOTICES.md` for the underlying Sentry SDK and bundled dependencies.
