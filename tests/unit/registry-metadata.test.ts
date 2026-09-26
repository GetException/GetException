import { describe, expect, it, vi } from "vitest";
import {
  lookupPublishedPackage,
  waitForPublishedPackages,
} from "../../scripts/release/registry-metadata";

const metadata = {
  dist: {
    tarball: "https://registry.npmjs.org/package.tgz",
    integrity: "sha512-example",
  },
};

describe("npm registry publication visibility", () => {
  it("bypasses cached metadata while polling an exact version", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(metadata));

    await expect(
      lookupPublishedPackage("browser", "1.2.3", 4, transport),
    ).resolves.toEqual(metadata);
    const [url, options] = transport.mock.calls[0]!;
    const request = new URL(String(url));

    expect(request.pathname).toBe("/@getexception%2fbrowser/1.2.3");
    expect(request.searchParams.get("getexception-attempt")).toBe("4");
    expect(options).toMatchObject({
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });
  });

  it("waits for all missing packages together and tolerates transient failures", async () => {
    const lookup = vi.fn(async (name: string, attempt: number) =>
      attempt >= (name === "browser" ? 2 : 3) ? metadata : undefined,
    );
    const pause = vi.fn(async () => undefined);
    const result = await waitForPublishedPackages(
      ["browser", "react"],
      lookup,
      3,
      pause,
    );

    expect([...result.keys()].sort()).toEqual(["browser", "react"]);
    expect(pause).toHaveBeenCalledTimes(3);
    expect(lookup).toHaveBeenCalledWith("browser", 1);
    expect(lookup).not.toHaveBeenCalledWith("browser", 3);
    expect(lookup).toHaveBeenCalledWith("react", 3);
  });

  it("reports every package still missing after the shared deadline", async () => {
    await expect(
      waitForPublishedPackages(
        ["react", "cli"],
        async () => undefined,
        2,
        async () => undefined,
      ),
    ).rejects.toThrow("react, cli");
  });
});
