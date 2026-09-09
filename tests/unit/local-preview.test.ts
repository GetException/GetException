import { expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnvironment, loadState } from "../../scripts/local/state";
import { randomBytes } from "node:crypto";

it("upgrades the previous local configuration without replacing account keys or saved ports", async () => {
  const directory = mkdtempSync(join(tmpdir(), "getexception-upgrade-test-"));
  const secret = () => randomBytes(32).toString("hex");
  const old = {
    version: 1,
    initialized: true,
    ports: {
      https: 8443,
      database: 25432,
      web: 23000,
      ingest: 23001,
      worker: 23002,
      retention: 23003,
    },
    passwords: {
      postgres: secret(),
      migrate: secret(),
      web: secret(),
      ingest: secret(),
      worker: secret(),
      backup: secret(),
    },
    secrets: {
      BETTER_AUTH_SECRET: secret(),
      TOTP_ENCRYPTION_KEY: secret(),
      AUTH_RATE_KEY: secret(),
    },
  };

  try {
    mkdirSync(join(directory, "data"));
    writeFileSync(join(directory, "data", "PG_VERSION"), "17\n");
    writeFileSync(join(directory, "config.json"), JSON.stringify(old));
    const upgraded = await loadState(directory);

    expect(upgraded.version).toBe(2);
    expect(upgraded.mailInitialized).toBe(false);
    expect(
      Object.entries(old.secrets).every(
        ([name, value]) =>
          upgraded.secrets[name as keyof typeof old.secrets] === value,
      ),
    ).toBe(true);
    expect(
      Object.entries(old.passwords).every(
        ([name, value]) =>
          upgraded.passwords[name as keyof typeof old.passwords] === value,
      ),
    ).toBe(true);
    expect(
      Object.entries(old.ports).every(
        ([name, value]) =>
          upgraded.ports[name as keyof typeof old.ports] === value,
      ),
    ).toBe(true);
    const serialized = readFileSync(join(directory, "config.json"), "utf8");

    await loadState(directory);
    expect(
      readFileSync(join(directory, "config.json"), "utf8") === serialized,
    ).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("refuses to generate fresh keys when existing database files have lost their configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "getexception-state-test-"));

  try {
    mkdirSync(join(directory, "data"));
    writeFileSync(join(directory, "data", "PG_VERSION"), "17\n");
    await expect(loadState(directory)).rejects.toThrow(
      "encryption keys were not regenerated",
    );
    expect(readFileSync(join(directory, "data", "PG_VERSION"), "utf8")).toBe(
      "17\n",
    );
    writeFileSync(join(directory, "config.json"), "{broken");
    await expect(loadState(directory)).rejects.toThrow(
      "configuration is invalid",
    );
    expect(readFileSync(join(directory, "config.json"), "utf8")).toBe(
      "{broken",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it("does not forward publishing tokens or unrelated database credentials to local child processes", () => {
  const names = [
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "YARN_NPM_AUTH_TOKEN",
    "DATABASE_URL",
    "TOTP_ENCRYPTION_KEY",
  ];
  const previous = names.map((name) => process.env[name]);

  try {
    for (const name of names) {
      process.env[name] = "test-only-canary";
    }

    const child = childEnvironment();

    expect(names.every((name) => child[name] === undefined)).toBe(true);
    expect(child.PATH === process.env.PATH).toBe(true);
  } finally {
    names.forEach((name, i) => {
      if (previous[i] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[i];
      }
    });
  }
});
