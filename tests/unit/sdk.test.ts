import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import * as SDK from "../../packages/browser/src/index";
import * as Sentry from "@getexception/sentry-browser";

let options: Parameters<typeof Sentry.init>[0];

vi.mock("@getexception/sentry-browser", () => ({
  init: vi.fn((input) => {
    options = input;
  }),
  globalHandlersIntegration: () => ({ name: "GlobalHandlers" }),
  browserApiErrorsIntegration: () => ({ name: "BrowserApiErrors" }),
  captureException: vi.fn(() => "captured"),
  captureMessage: vi.fn(() => "captured"),
  close: async () => true,
  flush: async () => true,
}));
afterEach(async () => {
  await SDK.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("safe SDK transport", () => {
  it("does nothing until init and tolerates invalid DSNs", () => {
    expect(SDK.captureException(new Error("inactive"))).toBe("");
    expect(Sentry.captureException).not.toHaveBeenCalled();
    SDK.init({ dsn: "http://invalid" });
    expect(SDK.captureMessage("inactive")).toBe("");
  });
  it("uses official capture integrations and sends only to the HTTPS DSN with no credentials or referrer", async () => {
    const key = randomBytes(32).toString("hex");
    const dsn = `https://${key}@ingest.example.com/${randomUUID()}`;
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);
    SDK.init({ dsn });
    expect(options?.defaultIntegrations).toBe(false);
    expect(options?.sendDefaultPii).toBe(false);
    const transport = options?.transport?.({
      url: SDK.dsnEndpoint(dsn),
      recordDroppedEvent: () => {},
    });

    expect(transport).toBeDefined();
    await transport!.send([
      { event_id: "a".repeat(32), sent_at: new Date().toISOString() },
      [
        [
          { type: "event" },
          {
            event_id: "a".repeat(32),
            message: "test",
            type: undefined,
            request: { headers: { authorization: "private" } },
            user: { email: "private@example.com" },
          },
        ],
      ],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];

    expect(new URL(url).origin).toBe("https://ingest.example.com");
    expect(request.credentials).toBe("omit");
    expect(request.referrerPolicy).toBe("no-referrer");
    expect(request.redirect).toBe("error");
    expect(String(request.body).includes("private")).toBe(false);
  });
  it("absorbs transport failures and declines unsupported severities", async () => {
    SDK.init({
      dsn: `https://${randomBytes(32).toString("hex")}@ingest.example.com/${randomUUID()}`,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unavailable");
      }),
    );
    const transport = options?.transport?.({
      url: "https://ingest.example.com",
      recordDroppedEvent: () => {},
    });

    await expect(
      transport!.send([
        { event_id: "a".repeat(32), sent_at: new Date().toISOString() },
        [
          [
            { type: "event" },
            { event_id: "a".repeat(32), message: "test", type: undefined },
          ],
        ],
      ]),
    ).resolves.toEqual({ statusCode: 0 });
    expect(
      SDK.captureMessage("informational", "info" as SDK.SeverityLevel),
    ).toBe("");
    expect(SDK.captureException(new Error("safe"))).toBe("captured");
  });
});
