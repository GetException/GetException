import { createConnection, type Socket } from "node:net";
import { connect } from "node:tls";
import nodemailer from "nodemailer";
import type { mailConfig } from "@getexception/config";
import type { MailSender } from "./queue";

export function smtpSender(config: ReturnType<typeof mailConfig>): MailSender {
  if (!config.MAIL_ENABLED) {
    throw new Error("Email delivery is disabled");
  }

  return async (payload, messageId) => {
    let socket: Socket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const secure = config.SMTP_MODE === "tls";
    const transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure,
      requireTLS: config.SMTP_MODE === "starttls",
      ignoreTLS: config.SMTP_MODE === "local",
      auth: config.SMTP_USER
        ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD ?? "" }
        : undefined,
      connectionTimeout: 3000,
      greetingTimeout: 3000,
      socketTimeout: 5000,
      dnsTimeout: 3000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      // Own the underlying socket so the total delivery deadline also aborts SMTP I/O.
      getSocket: (
        _options: unknown,
        callback: (
          error: Error | null,
          result: { connection?: Socket; secured?: boolean },
        ) => void,
      ) => {
        let completed = false;

        socket = secure
          ? connect({
              host: config.SMTP_HOST,
              port: config.SMTP_PORT,
              servername: config.SMTP_HOST,
              minVersion: "TLSv1.2",
            })
          : createConnection({
              host: config.SMTP_HOST,
              port: config.SMTP_PORT,
            });
        socket.once("error", () => {
          if (!completed) {
            completed = true;
            callback(new Error("SMTP unavailable"), {});
          }
        });
        socket.once(secure ? "secureConnect" : "connect", () => {
          if (!completed) {
            completed = true;
            callback(null, { connection: socket, secured: secure });
          }
        });
      },
    });

    try {
      await Promise.race([
        transport.sendMail({
          from: { name: "GetException", address: config.SMTP_FROM },
          to: { name: "", address: payload.to },
          subject: payload.subject,
          text: payload.text,
          messageId: `<${messageId}@${config.SMTP_FROM.split("@")[1]}>`,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            socket?.destroy();
            reject(new Error("SMTP deadline"));
          }, 8000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      socket?.destroy();
      transport.close();
    }
  };
}
