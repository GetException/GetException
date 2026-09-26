import { setTimeout } from "node:timers/promises";

export type PublishedPackage = {
  dist: { tarball: string; integrity: string };
};

type Transport = typeof fetch;

export async function lookupPublishedPackage(
  name: string,
  version: string,
  attempt: number,
  transport: Transport = fetch,
) {
  const url = new URL(
    `https://registry.npmjs.org/@getexception%2f${name}/${version}`,
  );

  url.searchParams.set("getexception-attempt", String(attempt));
  url.searchParams.set("getexception-time", String(Date.now()));
  const response = await transport(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error("npm registry metadata is unavailable");
  }

  return (await response.json()) as PublishedPackage;
}

export async function waitForPublishedPackages(
  names: readonly string[],
  lookup: (
    name: string,
    attempt: number,
  ) => Promise<PublishedPackage | undefined>,
  attempts = 120,
  pause: () => Promise<unknown> = () => setTimeout(5_000),
) {
  const pending = new Set(names);
  const published = new Map<string, PublishedPackage>();

  for (let attempt = 1; pending.size && attempt <= attempts; attempt++) {
    await pause();
    const results = await Promise.all(
      [...pending].map(async (name) => {
        try {
          return [name, await lookup(name, attempt)] as const;
        } catch {
          return [name, undefined] as const;
        }
      }),
    );

    for (const [name, metadata] of results) {
      if (metadata) {
        pending.delete(name);
        published.set(name, metadata);
      }
    }
  }

  if (pending.size) {
    throw new Error(
      `Published SDKs did not appear in npm within the deadline: ${[...pending].join(", ")}`,
    );
  }

  return published;
}
