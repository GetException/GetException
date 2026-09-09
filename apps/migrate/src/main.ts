import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createDatabase } from "@getexception/db";

const require = createRequire(import.meta.url);
const migration = spawnSync(
  process.execPath,
  [require.resolve("prisma/build/index.js"), "migrate", "deploy"],
  { stdio: "inherit" },
);

if (migration.status !== 0) {
  process.exit(migration.status ?? 1);
}

const db = createDatabase(process.env.DATABASE_URL ?? "");

try {
  if (!(await db.systemSetting.findUnique({ where: { id: 1 } }))) {
    const tokenHash = process.env.SETUP_TOKEN_HASH;

    if (!tokenHash || !/^[a-f0-9]{64}$/.test(tokenHash)) {
      throw new Error("SETUP_TOKEN_HASH is required");
    }

    await db.bootstrapToken.upsert({
      where: { id: 1 },
      create: { id: 1, tokenHash, expiresAt: new Date(Date.now() + 86400_000) },
      update: {},
    });
  }
} finally {
  await db.$disconnect();
}
