import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { openPage } from "../../e2e/navigation";

describe("deployment navigation after restart", () => {
  it("opens the document before a streamed redirect and leaves assertions to the caller", async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(null),
      waitForTimeout: vi.fn(),
    };

    await openPage(page, "https://monitor.localhost/setup");
    expect(page.goto).toHaveBeenCalledWith("https://monitor.localhost/setup", {
      waitUntil: "commit",
    });
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it("retries a temporary connection reset and succeeds", async () => {
    const page = {
      goto: vi
        .fn()
        .mockRejectedValueOnce(new Error("net::ERR_CONNECTION_RESET"))
        .mockResolvedValue(null),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    await openPage(page, "https://monitor.localhost/setup");
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.waitForTimeout).toHaveBeenCalledWith(250);
  });

  it("stops after three failed navigation requests and preserves a safe code", async () => {
    const page = {
      goto: vi.fn().mockRejectedValue(new Error("net::ERR_CONNECTION_CLOSED")),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      openPage(page, "https://monitor.localhost/setup"),
    ).rejects.toThrow("ERR_CONNECTION_CLOSED");
    expect(page.goto).toHaveBeenCalledTimes(3);
    expect(page.waitForTimeout.mock.calls).toEqual([[250], [500]]);
  });

  it("does not retry certificate failures or print exception contents and request URLs", async () => {
    const privateValue = randomBytes(24).toString("hex");
    const page = {
      goto: vi
        .fn()
        .mockRejectedValue(
          new Error("net::ERR_CERT_AUTHORITY_INVALID " + privateValue),
        ),
      waitForTimeout: vi.fn(),
    };

    await expect(
      openPage(page, "https://monitor.localhost/" + privateValue),
    ).rejects.toThrow("Navigation failed: UNCLASSIFIED");
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });
});
