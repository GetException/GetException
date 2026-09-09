import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { resolve, join } from "node:path";
import { loadState, LocalError, privateDirectory } from "./local/state";
import { startLocalStack } from "./local/stack";

process.umask(0o077);
const directory = resolve("runtime/local");
const socketPath = join(directory, "control.sock");
const lock = join(directory, "runner.pid");

async function stopExisting() {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let reply = "";

    socket.setTimeout(45_000, () =>
      socket.destroy(
        new LocalError(
          "Local shutdown timed out; database files were preserved.",
        ),
      ),
    );
    socket.once("connect", () => socket.write("stop\n"));
    socket.on("data", (chunk: Buffer) => {
      reply += chunk.toString();
    });
    socket.once("error", () =>
      reject(
        new LocalError(
          "No local preview control socket is available. The data remains in runtime/local.",
        ),
      ),
    );
    socket.once("end", () =>
      reply.trim() === "stopped"
        ? resolve()
        : reject(new LocalError("Unable to confirm local shutdown.")),
    );
  });
  process.stdout.write(
    "GetException stopped. Account, MFA, projects and events are preserved.\n",
  );
}

function acquireLock() {
  privateDirectory(directory);

  if (existsSync(lock)) {
    const saved = readFileSync(lock, "utf8").trim();
    const pid = Number(saved);

    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new LocalError(
        "The local runner lock is invalid; existing files were preserved.",
      );
    }

    let alive = true;

    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        alive = false;
      }
    }

    if (alive) {
      throw new LocalError(
        "A local preview is already running. Use yarn local:stop before restarting.",
      );
    }

    if (readFileSync(lock, "utf8").trim() === saved) {
      unlinkSync(lock);
    }
  }

  writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
}

async function start() {
  acquireLock();

  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  let starting:
    Promise<Awaited<ReturnType<typeof startLocalStack>>> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        await (await starting)?.stop();
      } catch {
        /* Startup already reported its fixed diagnostic. */
      }

      server.close();

      if (
        existsSync(lock) &&
        readFileSync(lock, "utf8") === String(process.pid)
      ) {
        unlinkSync(lock);
      }
    })());
  const server = createServer((socket) => {
    socket.setTimeout(5000, () => socket.destroy());
    socket.once("error", () => {});
    socket.once("data", (chunk: Buffer) => {
      if (chunk.length > 32 || chunk.toString().trim() !== "stop") {
        socket.end("invalid\n");

        return;
      }

      socket.setTimeout(0);
      void stop().then(() => socket.end("stopped\n"));
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    const state = await loadState(
      directory,
      Number(process.env.LOCAL_HTTPS_PORT ?? 8443),
    );

    if (stopping) {
      return;
    }

    starting = startLocalStack(directory, state);
    const stack = await starting;

    if (stopping) {
      return;
    }

    for (const child of stack.children) {
      child.once("exit", () => {
        if (!stopping) {
          process.stderr.write(
            "A local service stopped unexpectedly. Stopping the remaining services; saved data is preserved.\n",
          );
          process.exitCode = 1;
          void stop();
        }
      });
    }

    process.stdout.write(
      `GetException is ready: ${stack.origins.dashboard}/${stack.installed ? "login" : "setup"}\n`,
    );
    process.stdout.write(`Local email inbox: ${stack.origins.mail}\n`);

    if (!stack.installed) {
      process.stdout.write(
        "One-time setup token: runtime/local/setup-token (local file only).\n",
      );
    }

    process.stdout.write(
      "Persistent data: runtime/local. Stop with Ctrl+C or yarn local:stop.\n",
    );
  } catch (error) {
    await stop();

    throw error;
  }
}

try {
  if (process.argv[2] === "stop") {
    await stopExisting();
  } else if (process.argv[2]) {
    throw new LocalError("Usage: yarn local:start or yarn local:stop");
  } else {
    await start();
  }
} catch (error) {
  process.stderr.write(
    (error instanceof LocalError
      ? error.message
      : "Local preview failed. Saved data and keys were preserved; check the local prerequisites in docs/local-preview.md.") +
      "\n",
  );
  process.exitCode = 1;
}
