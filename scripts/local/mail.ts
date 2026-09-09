import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launch, stopChild } from "./processes";
import { LocalError, type LocalState } from "./state";

export async function startMailpit(directory: string, state: LocalState) {
  const binary =
    process.env.MAILPIT_BINARY ?? resolve(".artifacts/tools/mailpit");

  if (!existsSync(binary)) {
    throw new LocalError(
      "Mailpit is missing. Run yarn local:mailpit once; see docs/local-preview.md.",
    );
  }

  const child = launch(binary, [], {
    MP_UI_BIND_ADDR: `127.0.0.1:${state.ports.mailUi}`,
    MP_SMTP_BIND_ADDR: `127.0.0.1:${state.ports.smtp}`,
    MP_DATABASE: join(directory, "mailpit.db"),
    MP_DISABLE_VERSION_CHECK: "true",
    MP_SMTP_DISABLE_RDNS: "true",
    MP_ALLOWED_HOSTS: "127.0.0.1,localhost",
    MP_MAX_MESSAGES: "500",
    MP_QUIET: "true",
  });

  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      break;
    }

    try {
      if (
        (
          await fetch(`http://127.0.0.1:${state.ports.mailUi}/livez`, {
            signal: AbortSignal.timeout(500),
          })
        ).ok
      ) {
        return child;
      }
    } catch {
      /* Starting. */
    }

    await delay(100);
  }

  await stopChild(child);

  throw new LocalError("The local Mailpit inbox did not become ready.");
}
