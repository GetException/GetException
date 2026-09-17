import { afterEach, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import * as SDK from "../../packages/browser/src/index";
import { version } from "../../packages/browser/package.json";

afterEach(async () => {
  await SDK.close();
  vi.unstubAllGlobals();
});

it("official Sentry capture sends to the original UUID even when it begins with a letter", async () => {
  const projectId = "abcdefab-1234-4567-8123-abcdefabcdef";
  const send = vi.fn(async () => new Response(null, { status: 200 }));

  vi.stubGlobal("fetch", send);
  SDK.init({
    dsn: `https://${randomBytes(32).toString("hex")}@ingest.example.test/${projectId}`,
  });
  const id = SDK.captureException(new Error("Real SDK compatibility error"));

  expect(id).toMatch(/^[a-f0-9]{32}$/);
  expect(await SDK.flush()).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  const [target, request] = send.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];

  expect(new URL(target).pathname).toBe(`/api/${projectId}/envelope/`);
  expect(String(request.body)).toContain("Real SDK compatibility error");
  expect(String(request.body).split("\n")[0]).not.toContain("dsn");
  expect(JSON.parse(String(request.body).split("\n")[2]).sdk).toEqual({
    name: "getexception.javascript.browser",
    version,
  });
});

it("withScope runs before init and preserves exceptions thrown by application code", () => {
  let called = false;

  expect(
    SDK.withScope(() => {
      called = true;

      return 42;
    }),
  ).toBe(42);
  expect(called).toBe(true);
  const error = new Error("Application exception");

  expect(() =>
    SDK.withScope(() => {
      throw error;
    }),
  ).toThrow(error);
});

it("sends API/browser/debug identity without leaking scope data into the next event", async () => {
  const send = vi.fn(async () => new Response(null, { status: 200 }));

  vi.stubGlobal("fetch", send);
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 Chrome/140.2.3.4 Safari/537.36",
  });
  vi.stubGlobal("__GETEXCEPTION_DEBUG_IDS__", {
    "https://app.example.test/app.js": "a1b2c3d4-1234-4234-8234-123456789abc",
  });
  SDK.init({
    dsn: `https://${randomBytes(32).toString("hex")}@ingest.example.test/abcdefab-1234-4567-8123-abcdefabcdef`,
  });
  const error = new Error("Scoped API failure");

  error.stack =
    "Error: Scoped API failure\n    at request (https://app.example.test/app.js:2:3)";
  SDK.withScope((scope) => {
    scope.setTag("operation", "request.account");
    scope.setContext("api", {
      code: "error.account",
      reason: "forbidden",
      status_code: 403,
    });
    SDK.captureException(error);
  });
  await SDK.flush();
  SDK.captureException(new Error("Next failure"));
  await SDK.flush();
  const events = send.mock.calls.map((call) =>
    JSON.parse(
      String((call as unknown as [string, RequestInit])[1].body).split(
        "\n",
      )[2]!,
    ),
  );

  expect(events).toHaveLength(2);
  expect(events[0].contexts).toMatchObject({
    api: { code: "error.account", reason: "forbidden", status_code: 403 },
    browser: { name: "Chrome", major: 140 },
  });
  expect(events[0].exception.values[0].stacktrace.frames[0].debug_id).toBe(
    "a1b2c3d4-1234-4234-8234-123456789abc",
  );
  expect(events[1].contexts.api).toBeUndefined();
  expect(events[1].tags.operation).toBeUndefined();
  expect(JSON.stringify(events)).not.toContain("Chrome/140.2.3.4");
  SDK.captureException(new Error("Per-event fields"), {
    contexts: {
      api: { code: "error.other", reason: "timeout", status_code: 504 },
    },
  });
  await SDK.flush();
  const last = JSON.parse(
    String(
      (send.mock.calls[2] as unknown as [string, RequestInit])[1].body,
    ).split("\n")[2]!,
  );

  expect(last.contexts.api).toMatchObject({
    code: "error.other",
    reason: "timeout",
    status_code: 504,
  });
});
