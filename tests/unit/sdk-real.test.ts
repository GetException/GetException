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
