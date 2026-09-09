import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { childEnvironment, LocalError } from "./state";

export function launch(
  command: string,
  args: string[],
  env: Record<string, string | undefined> = {},
) {
  const child = spawn(command, args, {
    env: { ...childEnvironment(), ...env },
    stdio: "ignore",
  });

  child.on("error", () => {}); // Report only the fixed startup stage; never child credentials or payloads.

  return child;
}

export async function stopChild(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill(signal);
  });
}

export async function requireFreePort(port: number) {
  const probe = createServer();

  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
  } catch {
    throw new LocalError(
      `Local port ${port} is occupied. Stop the existing process; saved addresses were not changed.`,
    );
  }

  await new Promise<void>((resolve) => probe.close(() => resolve()));
}

export async function ready(child: ChildProcess, port: number, name: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
      break;
    }

    try {
      if (
        (
          await fetch(`http://127.0.0.1:${port}/health/ready`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      ) {
        return;
      }
    } catch {
      /* Starting. */
    }

    await delay(200);
  }

  throw new LocalError(
    `${name} did not become ready. Saved data is unchanged; run yarn checks before starting.`,
  );
}
