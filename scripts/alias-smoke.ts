import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sdkVersion = JSON.parse(
  readFileSync("packages/browser/package.json", "utf8"),
).version as string;
const directory = mkdtempSync(join(tmpdir(), "getexception-alias-"));
const env = { ...process.env };

delete env.NPM_TOKEN;
delete env.NODE_AUTH_TOKEN;
delete env.YARN_NPM_AUTH_TOKEN;

async function run(command: string, args: string[], cwd = process.cwd()) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  if (code !== 0) {
    throw new Error(
      `Alias smoke command failed: ${command} (${code})\n${stderr.slice(-1500)}`,
    );
  }
}

for (const name of ["browser", "react"]) {
  await run("corepack", [
    "yarn",
    "workspace",
    `@getexception/${name}`,
    "pack",
    "--out",
    join(directory, `${name}.tgz`),
  ]);
}

let origin = "";
const server = createServer((request, response) => {
  const path = decodeURIComponent(
    new URL(request.url ?? "/", "http://registry.invalid").pathname,
  );
  const name = path.includes("browser")
    ? "browser"
    : path.includes("react")
      ? "react"
      : undefined;

  if (!name) {
    response.writeHead(404).end();

    return;
  }

  const archive = readFileSync(join(directory, `${name}.tgz`));

  if (path.startsWith("/tar/")) {
    response
      .writeHead(200, { "Content-Type": "application/octet-stream" })
      .end(archive);

    return;
  }

  const manifest = JSON.parse(
    readFileSync(`packages/${name}/package.json`, "utf8"),
  );
  const dependencies = { ...manifest.dependencies };

  if (dependencies["@getexception/browser"]) {
    dependencies["@getexception/browser"] = sdkVersion;
  }

  const version = {
    name: manifest.name,
    version: sdkVersion,
    dependencies,
    peerDependencies: manifest.peerDependencies,
    dist: {
      tarball: `${origin}/tar/${name}.tgz`,
      shasum: createHash("sha1").update(archive).digest("hex"),
    },
  };

  response.writeHead(200, { "Content-Type": "application/json" }).end(
    JSON.stringify({
      name: manifest.name,
      "dist-tags": { latest: sdkVersion },
      versions: { [sdkVersion]: version },
      time: {
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-01T00:00:00.000Z",
        [sdkVersion]: "2026-01-01T00:00:00.000Z",
      },
    }),
  );
});

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("No registry port");
  }

  origin = `http://127.0.0.1:${address.port}`;
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "@getexception/alias-smoke",
      private: true,
      type: "module",
      packageManager: "yarn@4.17.1",
      dependencies: {
        "@sentry/browser": `npm:@getexception/browser@${sdkVersion}`,
        "@sentry/react": `npm:@getexception/react@${sdkVersion}`,
        react: "19.2.8",
      },
    }),
  );
  writeFileSync(
    join(directory, ".yarnrc.yml"),
    `nodeLinker: node-modules\nglobalFolder: ${join(directory, ".yarn-global")}\nenableScripts: false\nenableTelemetry: false\nunsafeHttpWhitelist: [127.0.0.1]\nnpmScopes:\n  getexception:\n    npmRegistryServer: ${origin}\n`,
  );
  await run("corepack", ["yarn", "install", "--mode=skip-build"], directory);
  await run(
    "corepack",
    ["yarn", "install", "--immutable", "--mode=skip-build"],
    directory,
  );
  const source =
    'import * as Browser from "@sentry/browser"; import * as React from "@sentry/react"; const required = ["init", "captureException", "captureMessage", "setTag", "setTags", "setContext", "addBreadcrumb", "withScope", "flush", "close"]; if (required.some(key => typeof Browser[key] !== "function" || typeof React[key] !== "function") || !React.ErrorBoundary) throw Error("Missing compatible exports");';

  writeFileSync(join(directory, "smoke.mjs"), source);
  await run(process.execPath, ["smoke.mjs"], directory);
  writeFileSync(
    join(directory, "contract.ts"),
    'import * as Sentry from "@sentry/browser"; import { ErrorBoundary } from "@sentry/react"; Sentry.captureMessage("Error", "fatal"); Sentry.withScope(scope => { scope.setTag("feature", "editor"); scope.setContext("app", { route: "/editor" }); Sentry.captureException(new Error("example")); }); void ErrorBoundary;',
  );
  await run(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--skipLibCheck",
      "--moduleResolution",
      "bundler",
      "--module",
      "esnext",
      "--target",
      "es2022",
      "contract.ts",
    ],
    directory,
  );
  process.stdout.write(
    "Both npm aliases installed from packed SDKs; runtime exports and TypeScript migration contract passed.\n",
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
}
