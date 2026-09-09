import { build } from "tsup";
import { spawnSync } from "node:child_process";

await build({
  entry: ["packages/browser/src/index.ts"],
  outDir: "packages/browser/dist",
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: false,
  external: ["@getexception/sentry-browser"],
  noExternal: ["@getexception/protocol", "zod"],
});
await build({
  entry: ["packages/react/src/index.ts"],
  outDir: "packages/react/dist",
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: false,
  external: ["react", "@getexception/browser", "@getexception/sentry-react"],
});

for (const app of ["ingest", "worker"]) {
  await build({
    entry:
      app === "worker"
        ? {
            main: "apps/worker/src/main.ts",
            mail: "apps/worker/src/mail/main.ts",
          }
        : [`apps/${app}/src/main.ts`],
    outDir: `apps/${app}/dist`,
    format: ["esm"],
    platform: "node",
    target: "node24",
    clean: true,
    sourcemap: false,
    noExternal: [/^@getexception\//],
    external: ["@prisma/adapter-pg", "@prisma/client", "pg", "nodemailer"],
  });
}

await build({
  entry: ["apps/web/src/server/start.ts"],
  outDir: "apps/web/dist",
  format: ["esm"],
  platform: "node",
  target: "node24",
  clean: true,
  sourcemap: false,
  noExternal: [/^@getexception\//],
  external: [
    "next",
    "better-auth",
    "argon2",
    "pg",
    "@prisma/adapter-pg",
    "@prisma/client",
  ],
});

for (const workspace of [
  "@getexception/browser-spa",
  "@getexception/react-spa",
  "@getexception/web",
]) {
  const result = spawnSync(
    "corepack",
    ["yarn", "workspace", workspace, "build"],
    { stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
