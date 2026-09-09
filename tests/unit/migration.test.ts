import { afterEach, describe, expect, it, vi } from "vitest";

const { spawn, createDatabase, db } = vi.hoisted(() => ({
  spawn: vi.fn(),
  createDatabase: vi.fn(),
  db: {
    systemSetting: { findUnique: vi.fn() },
    bootstrapToken: { upsert: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

vi.mock("node:child_process", () => ({ spawnSync: spawn }));
vi.mock("@getexception/db", () => ({ createDatabase }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("migration entry point", () => {
  it("never seeds a database after a failed migration", async () => {
    spawn.mockReturnValue({ status: 1 });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("migration failed");
    });

    await expect(import("../../apps/migrate/src/main")).rejects.toThrow(
      "migration failed",
    );
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("preserves an existing installation without requiring a new setup token", async () => {
    spawn.mockReturnValue({ status: 0 });
    createDatabase.mockReturnValue(db);
    db.systemSetting.findUnique.mockResolvedValue({ id: 1 });
    vi.stubEnv("SETUP_TOKEN_HASH", "");

    await import("../../apps/migrate/src/main");

    expect(db.bootstrapToken.upsert).not.toHaveBeenCalled();
    expect(db.$disconnect).toHaveBeenCalledOnce();
  });

  it("rejects initial setup without a valid token and closes the database", async () => {
    spawn.mockReturnValue({ status: 0 });
    createDatabase.mockReturnValue(db);
    db.systemSetting.findUnique.mockResolvedValue(null);
    vi.stubEnv("SETUP_TOKEN_HASH", "");

    await expect(import("../../apps/migrate/src/main")).rejects.toThrow(
      "SETUP_TOKEN_HASH is required",
    );
    expect(db.bootstrapToken.upsert).not.toHaveBeenCalled();
    expect(db.$disconnect).toHaveBeenCalledOnce();
  });
});
