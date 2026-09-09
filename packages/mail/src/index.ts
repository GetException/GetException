import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface MailPayload {
  to: string;
  subject: string;
  text: string;
}

export function sealMail(
  payload: MailPayload,
  id: string,
  revision: number,
  key: string,
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), nonce);

  cipher.setAAD(
    Buffer.from(JSON.stringify(["getexception-mail", 1, id, revision])),
  );
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return [
    "v1",
    nonce.toString("base64url"),
    encrypted.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function openMail(
  value: string,
  id: string,
  revision: number,
  key: string,
): MailPayload {
  const [version, nonce, content, tag, extra] = value.split(".");

  if (
    version !== "v1" ||
    !nonce ||
    !content ||
    !tag ||
    extra ||
    value.length > 32768
  ) {
    throw new Error("Invalid mail");
  }

  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    Buffer.from(nonce, "base64url"),
  );

  cipher.setAAD(
    Buffer.from(JSON.stringify(["getexception-mail", 1, id, revision])),
  );
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  const data: unknown = JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(content, "base64url")),
      cipher.final(),
    ]).toString("utf8"),
  );

  if (
    !data ||
    typeof data !== "object" ||
    !("to" in data) ||
    !("subject" in data) ||
    !("text" in data) ||
    typeof data.to !== "string" ||
    !/^[^\s<>@]+@[^\s<>@]+$/.test(data.to) ||
    data.to.length > 254 ||
    typeof data.subject !== "string" ||
    /[\r\n]/.test(data.subject) ||
    data.subject.length > 200 ||
    typeof data.text !== "string" ||
    data.text.length > 10000
  ) {
    throw new Error("Invalid mail");
  }

  return { to: data.to, subject: data.subject, text: data.text };
}
