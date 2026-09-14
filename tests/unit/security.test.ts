import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  base32,
  decryptSecret,
  encryptSecret,
  newTotpSecret,
  passwordAllowed,
  totp,
  verifyTotp,
} from "../../apps/web/src/server/crypto";
import {
  webConfig,
  workerConcurrency,
  canonicalOrigin,
  isLoopbackOrigin,
} from "@getexception/config";
import { allowedDependency } from "../../scripts/architecture";
import {
  fingerprint,
  normalizeMessage,
} from "../../apps/worker/src/fingerprint";
import { sanitizeEvent } from "@getexception/protocol";

describe("MFA cryptographic boundary", () => {
  it("matches RFC 6238 six-digit truncations and rejects replay", () => {
    const secret = base32(Buffer.from("12345678901234567890"));

    expect(totp(secret, 1n)).toBe("287082");
    expect(verifyTotp(secret, "287082", -1n, 59000)).toBe(1n);
    expect(verifyTotp(secret, "287082", 1n, 59000)).toBeNull();
    expect(verifyTotp(secret, "0287082", -1n, 59000)).toBeNull();
    expect(verifyTotp(secret, "287082", -1n, 150_000)).toBeNull();
  });
  it("accepts exactly current and adjacent counters", () => {
    const secret = newTotpSecret();

    for (const counter of [99n, 100n, 101n]) {
      expect(verifyTotp(secret, totp(secret, counter), -1n, 3_000_000)).toBe(
        counter,
      );
    }

    expect(verifyTotp(secret, totp(secret, 98n), -1n, 3_000_000)).toBeNull();
  });
  it("binds random versioned ciphertext to the user and credential state", () => {
    const key = randomBytes(32).toString("hex"),
      secret = newTotpSecret();
    const pending = encryptSecret(secret, "owner", "pending", key),
      active = encryptSecret(secret, "owner", "active", key);

    expect(secret).toHaveLength(32);
    expect(pending.includes(secret)).toBe(false);
    expect(active).not.toBe(pending);
    expect(decryptSecret(pending, "owner", "pending", key)).toBe(secret);
    expect(decryptSecret(active, "owner", "active", key)).toBe(secret);
    expect(() =>
      decryptSecret(pending, "another-user", "pending", key),
    ).toThrow();
    expect(() => decryptSecret(pending, "owner", "active", key)).toThrow();
    expect(() =>
      decryptSecret(active, "owner", "active", randomBytes(32).toString("hex")),
    ).toThrow();
  });
  it("enforces configuration and password constraints", () => {
    expect(() => webConfig({ NODE_ENV: "production" })).toThrow();
    expect(() => workerConcurrency("0")).toThrow();
    expect(() => workerConcurrency("17")).toThrow();
    expect(workerConcurrency("4")).toBe(4);
    expect(passwordAllowed("password123456")).toBe(false);
    expect(passwordAllowed("x".repeat(129))).toBe(false);
    expect(passwordAllowed("three words and a lamp")).toBe(true);
    expect(canonicalOrigin("https://app.example.com")).toBe(
      "https://app.example.com",
    );
    expect(() => canonicalOrigin("https://app.example.com/path")).toThrow();
    expect(() => canonicalOrigin("http://app.example.com")).toThrow();
  });
});

describe("explicit local application origins", () => {
  it.each([
    "http://localhost:8080",
    "http://127.0.0.1:5173",
    "http://[::1]:8080",
  ])("allows %s only when local origins are explicitly enabled", (origin) => {
    expect(() => canonicalOrigin(origin)).toThrow();
    expect(canonicalOrigin(origin, true)).toBe(origin);
    expect(isLoopbackOrigin(origin)).toBe(true);
  });

  it.each([
    "not a URL",
    "null",
    "http://app.example.com",
    "http://localhost.example.com:8080",
    "http://192.168.1.1:8080",
    "http://localhost:8080/path",
    "http://localhost:8080?query=value",
    "http://localhost:8080#fragment",
    "http://user@localhost:8080",
    "ftp://localhost:8080",
    "https://*.example.com",
  ])("rejects invalid project origin %s", (origin) => {
    expect(() => canonicalOrigin(origin, true)).toThrow();
  });

  it("keeps HTTPS applications and exact host matching", () => {
    expect(canonicalOrigin("https://app.example.com/", true)).toBe(
      "https://app.example.com",
    );
    expect(isLoopbackOrigin("https://localhost:8080")).toBe(true);
    expect(isLoopbackOrigin("http://localhost.example.com:8080")).toBe(false);
    expect(isLoopbackOrigin("not a URL")).toBe(false);
  });
});
it("enforces architecture boundaries and groups stable causes", () => {
  expect(allowedDependency("browser", "db")).toBe(false);
  expect(allowedDependency("ingest", "web")).toBe(false);
  expect(allowedDependency("web", "worker")).toBe(false);
  expect(allowedDependency("ingest", "protocol")).toBe(true);
  expect(normalizeMessage("Entity 123 not found")).toBe(
    normalizeMessage("Entity 456 not found"),
  );
  const first = sanitizeEvent(
    { message: "Entity 123 not found" },
    "a".repeat(32),
  );
  const second = sanitizeEvent(
    { message: "Entity 456 not found" },
    "b".repeat(32),
  );

  expect(fingerprint(first)).toBe(fingerprint(second));
  expect(fingerprint({ ...first, exceptionType: "TypeError" })).not.toBe(
    fingerprint(first),
  );
});
