import { expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sealMail, openMail } from "@getexception/mail";
import { mailConfig } from "@getexception/config";
import { smtpSender } from "../../apps/worker/src/mail/smtp";

it("authenticates encrypted mail against its row and revision and rejects hostile headers", () => {
  const key = randomBytes(32).toString("hex");
  const id = randomUUID();
  const payload = {
    to: "developer@example.test",
    subject: "Invitation",
    text: randomBytes(32).toString("hex"),
  };
  const encrypted = sealMail(payload, id, 1, key);

  expect(encrypted.includes(payload.text)).toBe(false);
  expect(openMail(encrypted, id, 1, key).text === payload.text).toBe(true);
  expect(() => openMail(encrypted, randomUUID(), 1, key)).toThrow();
  expect(() => openMail(encrypted, id, 2, key)).toThrow();
  expect(() =>
    openMail(encrypted, id, 1, randomBytes(32).toString("hex")),
  ).toThrow();
  const hostile = sealMail(
    { ...payload, subject: "Subject\r\nBcc: attacker@example.test" },
    id,
    1,
    key,
  );

  expect(() => openMail(hostile, id, 1, key)).toThrow("Invalid mail");
});

it("permits plaintext SMTP only for the local catcher and requires encrypted SMTP otherwise", () => {
  const env = {
    DATABASE_URL: "postgresql://localhost/test",
    MAIL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "587",
    SMTP_FROM: "getexception@example.test",
  };

  expect(mailConfig(env)).toMatchObject({
    MAIL_ENABLED: true,
    SMTP_MODE: "starttls",
  });
  expect(() => mailConfig({ ...env, SMTP_MODE: "local" })).toThrow();
  expect(
    mailConfig({ ...env, SMTP_HOST: "127.0.0.1", SMTP_MODE: "local" }),
  ).toMatchObject({ SMTP_MODE: "local" });
});

it("starts with email disabled without SMTP and refuses to create a sender", () => {
  const env = {
    DATABASE_URL: "postgresql://localhost/test",
    MAIL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    MAIL_ENABLED: "false",
  };
  const config = mailConfig(env);

  expect(config.MAIL_ENABLED).toBe(false);
  expect(config).not.toHaveProperty("SMTP_HOST");
  expect(() => smtpSender(config)).toThrow("Email delivery is disabled");
  expect(() => mailConfig({ ...env, MAIL_ENABLED: "true" })).toThrow();
  expect(() => mailConfig({ ...env, MAIL_ENABLED: "no" })).toThrow();
});
