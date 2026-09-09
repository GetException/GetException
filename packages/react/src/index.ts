export {
  init,
  captureException,
  captureMessage,
  setTag,
  setTags,
  setContext,
  addBreadcrumb,
  withScope,
  flush,
  close,
} from "@getexception/browser";

export type {
  BrowserOptions,
  Breadcrumb,
  Scope,
  SeverityLevel,
} from "@getexception/browser";

// Official React integration shares the Sentry core client configured by our browser wrapper.
export { ErrorBoundary } from "@getexception/sentry-react";
