import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

const names = ["browser", "react"] as const;
const root = resolve(".artifacts/registry");
const publish = process.argv.includes("--publish");
const version = JSON.parse(
  readFileSync("packages/browser/package.json", "utf8"),
).version as string;

mkdirSync(root, { recursive: true });

function yarn(args: string[], cwd = process.cwd()) {
  const result = spawnSync("corepack", ["yarn", ...args], {
    cwd,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error("Release package command failed");
  }
}

async function lookup(name: string) {
  const response = await fetch(
    `https://registry.npmjs.org/@getexception%2f${name}/${version}`,
    { signal: AbortSignal.timeout(20_000) },
  );

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error("npm registry metadata is unavailable");
  }

  return (await response.json()) as {
    dist: { tarball: string; integrity: string };
  };
}

for (const name of names) {
  const manifest = JSON.parse(
    readFileSync(`packages/${name}/package.json`, "utf8"),
  );

  if (manifest.version !== version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("SDK versions must match");
  }

  let published = await lookup(name);

  if (publish && !published) {
    yarn([
      "workspace",
      `@getexception/${name}`,
      "npm",
      "publish",
      "--access",
      "public",
      "--provenance",
    ]);
  }

  for (let attempt = 0; !published && attempt < 30; attempt++) {
    await setTimeout(5000);
    published = await lookup(name);
  }

  if (!published) {
    throw new Error("Published SDK did not appear in npm within the deadline");
  }

  const url = new URL(published.dist.tarball);

  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org") {
    throw new Error("Unexpected npm tarball host");
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  if (!response.ok) {
    throw new Error("Unable to download the published SDK");
  }

  const archive = Buffer.from(await response.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;

  if (integrity !== published.dist.integrity) {
    throw new Error("Published SDK integrity check failed");
  }

  writeFileSync(resolve(root, `${name}.tgz`), archive);
  yarn([
    "workspace",
    `@getexception/${name}`,
    "pack",
    "--out",
    resolve(root, `${name}-expected.tgz`),
  ]);
  const compared = spawnSync(
    "python3",
    ["scripts/release/package-check.py", name],
    {
      stdio: "inherit",
    },
  );

  if (compared.status !== 0) {
    throw new Error("Published package differs from the release source");
  }
}

if (!publish) {
  writeFileSync(resolve(root, "yarn.lock"), "");
  writeFileSync(
    resolve(root, "package.json"),
    JSON.stringify({
      name: "@getexception/registry-smoke",
      private: true,
      type: "module",
      packageManager: "yarn@4.17.1",
      dependencies: {
        "@getexception/browser": `file:./browser.tgz`,
        "@getexception/react": `file:./react.tgz`,
        "@sentry/browser": `npm:@getexception/browser@${version}`,
        "@sentry/react": `npm:@getexception/react@${version}`,
        react: "19.2.8",
        "react-dom": "19.2.8",
        vite: "7.3.6",
      },
    }),
  );
  writeFileSync(
    resolve(root, ".yarnrc.yml"),
    "nodeLinker: node-modules\nenableScripts: false\n",
  );
  yarn(["install", "--no-immutable", "--mode=skip-build"], root);
  yarn(["install", "--immutable", "--mode=skip-build"], root);
  writeFileSync(
    resolve(root, "aliases.mjs"),
    'import * as Browser from "@sentry/browser"; import * as React from "@sentry/react"; if (typeof Browser.captureException !== "function" || typeof React.captureException !== "function" || !React.ErrorBoundary) throw Error("Published Sentry aliases are incompatible");',
  );
  yarn(["node", "aliases.mjs"], root);

  for (const name of names) {
    cpSync(`fixtures/${name}-spa`, resolve(root, `${name}-spa`), {
      recursive: true,
      filter: (path) => !/(?:^|\/)(?:node_modules|dist)(?:\/|$)/.test(path),
    });
    // Resolve the downloaded packages from this clean directory, outside the monorepo workspaces.
    yarn(["vite", "build", `${name}-spa`], root);
  }
}

process.stdout.write(
  "Published SDK contents and registry integrity verified.\n",
);
