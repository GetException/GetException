import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadState, availablePort } from "../../scripts/local/state";
import { startMailpit } from "../../scripts/local/mail";
import { stopChild } from "../../scripts/local/processes";
import { smtpSender } from "../../apps/worker/src/mail/smtp";
import { mailConfig } from "@getexception/config";
import { createServer } from "node:net";

it("delivers only to the temporary local Mailpit inbox", async () => {
  const directory = mkdtempSync(join(tmpdir(), "getexception-mail-test-"));
  let catcher: Awaited<ReturnType<typeof startMailpit>> | undefined;

  try {
    const state = await loadState(directory, await availablePort());

    state.ports.mailUi = await availablePort();
    catcher = await startMailpit(directory, state);
    const send = smtpSender(
      mailConfig({
        DATABASE_URL: "postgresql://localhost/unused_test",
        MAIL_ENCRYPTION_KEY: state.secrets.MAIL_ENCRYPTION_KEY,
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(state.ports.smtp),
        SMTP_MODE: "local",
        SMTP_FROM: "getexception@example.test",
      }),
    );

    await send(
      {
        to: "developer@example.test",
        subject: "SMTP integration test",
        text: "Local delivery test.",
      },
      randomUUID(),
    );
    const response = await fetch(
      `http://127.0.0.1:${state.ports.mailUi}/api/v1/messages`,
    );

    expect(response.ok).toBe(true);
    const data = (await response.json()) as {
      messages: { Subject: string; To: { Address: string }[] }[];
    };

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({
      Subject: "SMTP integration test",
      To: [{ Address: "developer@example.test" }],
    });
  } finally {
    if (catcher) {
      await stopChild(catcher);
    }

    rmSync(directory, { recursive: true, force: true });
  }
});

it("closes stalled SMTP sockets within the bounded delivery deadline", async () => {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Test port missing");
  }

  try {
    const send = smtpSender(
      mailConfig({
        DATABASE_URL: "postgresql://localhost/unused_test",
        MAIL_ENCRYPTION_KEY: randomUUID().replaceAll("-", "").repeat(2),
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(address.port),
        SMTP_MODE: "local",
        SMTP_FROM: "getexception@example.test",
      }),
    );
    const start = Date.now();

    await expect(
      send(
        {
          to: "viewer@example.test",
          subject: "Local stall test",
          text: "Test",
        },
        randomUUID(),
      ),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(10_000);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
