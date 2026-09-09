import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import argon2 from "argon2";

export const token = () => randomBytes(32).toString("hex");

export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function constantEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newTotpSecret() {
  return base32(randomBytes(20));
}

export function base32(bytes: Uint8Array): string {
  let bits = 0,
    value = 0,
    out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits) {
    out += alphabet[(value << (5 - bits)) & 31];
  }

  return out;
}

function decode32(text: string) {
  let bits = 0,
    value = 0;
  const out: number[] = [];

  for (const c of text) {
    const digit = alphabet.indexOf(c);

    if (digit < 0) {
      throw new Error("Invalid credential");
    }

    value = (value << 5) | digit;
    bits += 5;

    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

export function totp(secret: string, counter: bigint): string {
  const input = Buffer.alloc(8);

  input.writeBigUInt64BE(counter);
  const mac = createHmac("sha1", decode32(secret)).update(input).digest();
  const offset = mac[19]! & 15;

  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}

export function verifyTotp(
  secret: string,
  code: string,
  lastCounter: bigint,
  now = Date.now(),
): bigint | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }

  const counter = BigInt(Math.floor(now / 30_000));
  let match: bigint | null = null;

  for (const delta of [-1n, 0n, 1n]) {
    const period = counter + delta;

    if (period < 0n) {
      continue;
    }

    const accepted = constantEqual(totp(secret, period), code);

    if (accepted && period > lastCounter) {
      match = period;
    }
  }

  return match;
}

export function encryptSecret(
  secret: string,
  userId: string,
  state: "pending" | "active",
  key: string,
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), nonce);

  cipher.setAAD(
    Buffer.from(JSON.stringify(["getexception-totp", 1, userId, state])),
  );
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);

  return [
    "v1",
    nonce.toString("base64url"),
    encrypted.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function decryptSecret(
  ciphertext: string,
  userId: string,
  state: "pending" | "active",
  key: string,
) {
  const [version, nonce, content, tag, extra] = ciphertext.split(".");

  if (
    version !== "v1" ||
    !nonce ||
    !content ||
    !tag ||
    extra ||
    Buffer.from(nonce, "base64url").length !== 12 ||
    Buffer.from(tag, "base64url").length !== 16
  ) {
    throw new Error("Invalid credential");
  }

  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    Buffer.from(nonce, "base64url"),
  );

  cipher.setAAD(
    Buffer.from(JSON.stringify(["getexception-totp", 1, userId, state])),
  );
  cipher.setAuthTag(Buffer.from(tag, "base64url"));

  return Buffer.concat([
    cipher.update(Buffer.from(content, "base64url")),
    cipher.final(),
  ]).toString("utf8");
}

// Small local deny-list; expand from an audited offline breached-password corpus before production.
const commonPasswords = new Set([
  "password1234",
  "password12345",
  "password123456",
  "123456789012",
  "qwerty12345678",
  "administrator",
  "letmein123456",
]);

export function passwordAllowed(value: string) {
  return (
    value.length >= 12 &&
    value.length <= 128 &&
    !commonPasswords.has(value.toLowerCase())
  );
}

export const hashPassword = (password: string) =>
  argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });

export const verifyPassword = async (hash: string, password: string) => {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
};

export function recoveryCodes() {
  return Array.from({ length: 10 }, () => randomBytes(16).toString("hex"));
}
