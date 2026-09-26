import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { registryConsumerConfig } from "./consumer-config";
import {
  lookupPublishedPackage,
  type PublishedPackage,
  waitForPublishedPackages,
} from "./registry-metadata";

const names = ["browser", "react", "cli"] as const;
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

for (const name of names) {
  const manifest = JSON.parse(
    readFileSync(`packages/${name}/package.json`, "utf8"),
  );

  if (manifest.version !== version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("SDK versions must match");
  }

  const archive = resolve(root, `${name}-expected.tgz`);

  yarn(["workspace", `@getexception/${name}`, "pack", "--out", archive]);
  const checked = spawnSync(
    "python3",
    ["scripts/release/package-check.py", name, "--archive", archive],
    { stdio: "inherit" },
  );

  if (checked.status !== 0) {
    throw new Error("SDK archive review failed before publication");
  }
}

const published = new Map<string, PublishedPackage>();
const missing: string[] = [];

for (const name of names) {
  const metadata = await lookupPublishedPackage(name, version, 0);

  if (metadata) {
    published.set(name, metadata);
  } else {
    missing.push(name);
  }
}

if (publish) {
  for (const name of missing) {
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
}

if (missing.length) {
  const appeared = await waitForPublishedPackages(missing, (name, attempt) =>
    lookupPublishedPackage(name, version, attempt),
  );

  for (const [name, metadata] of appeared) {
    published.set(name, metadata);
  }
}

for (const name of names) {
  const metadata = published.get(name);

  if (!metadata) {
    throw new Error(`Published SDK metadata is missing: ${name}`);
  }

  const url = new URL(metadata.dist.tarball);

  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org") {
    throw new Error("Unexpected npm tarball host");
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  if (!response.ok) {
    throw new Error("Unable to download the published SDK");
  }

  const archive = Buffer.from(await response.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;

  if (integrity !== metadata.dist.integrity) {
    throw new Error("Published SDK integrity check failed");
  }

  writeFileSync(resolve(root, `${name}.tgz`), archive);
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
        "@getexception/cli": `file:./cli.tgz`,
        "@sentry/browser": `npm:@getexception/browser@${version}`,
        "@sentry/react": `npm:@getexception/react@${version}`,
        react: "18.3.1",
        "react-dom": "18.3.1",
        vite: "7.3.6",
      },
    }),
  );
  writeFileSync(
    resolve(root, ".yarnrc.yml"),
    stringify(registryConsumerConfig(version)),
  );
  yarn(["install", "--no-immutable", "--mode=skip-build"], root);
  yarn(["install", "--immutable", "--mode=skip-build"], root);
  writeFileSync(
    resolve(root, "aliases.mjs"),
    'import * as Browser from "@sentry/browser"; import * as React from "@sentry/react"; if (typeof Browser.captureException !== "function" || typeof React.captureException !== "function" || !React.ErrorBoundary) throw Error("Published Sentry aliases are incompatible");',
  );
  yarn(["node", "aliases.mjs"], root);

  yarn(["exec", "getexception", "--help"], root);

  for (const name of ["browser", "react"]) {
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
