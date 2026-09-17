import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import type { SourceMapStore } from "@getexception/source-maps";
import {
  originalFrameSchema,
  type OriginalFrame,
  type SafeFrame,
  SOURCE_MAP_LIMITS,
} from "@getexception/protocol";

// One bounded parser isolate per process, independent from event concurrency.
let parserQueue: Promise<unknown> = Promise.resolve();

export async function parseSourceMap(
  text: string,
  debugId: string,
  path: string,
  frames: SafeFrame[] = [],
): Promise<(OriginalFrame | null)[]> {
  const operation = parserQueue.then(() =>
    runParser(text, debugId, path, frames),
  );

  parserQueue = operation.catch(() => {});

  return operation;
}

export async function parseStoredMap(
  store: SourceMapStore,
  file: {
    id: string;
    storageId: string;
    debugId: string;
    path: string;
    size: number;
    sha256: string;
  },
  frames: SafeFrame[] = [],
) {
  // Queue file identities, not 16 MiB payloads for each event worker.
  const operation = parserQueue.then(async () => {
    const bytes = await store.read(file.storageId);

    if (
      bytes.length !== file.size ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    ) {
      throw new Error("Invalid artifact");
    }

    return runParser(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      file.debugId,
      file.path,
      frames,
    );
  });

  parserQueue = operation.catch(() => {});

  return operation;
}

async function runParser(
  text: string,
  debugId: string,
  path: string,
  frames: SafeFrame[],
) {
  if (
    Buffer.byteLength(text) > SOURCE_MAP_LIMITS.fileBytes ||
    frames.length > 100
  ) {
    throw new Error("Invalid map size");
  }

  return new Promise<(OriginalFrame | null)[]>((resolve, reject) => {
    const source = import.meta.url.endsWith(".ts")
      ? new URL("./symbolication.ts", import.meta.url)
      : new URL("./symbolication.js", import.meta.url);
    const worker = new Worker(source, {
      workerData: { text, debugId, path, frames },
      env: {},
      execArgv: import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [],
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    let settled = false;
    const finish = (result?: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      const parsed = originalFrameSchema
        .nullable()
        .array()
        .max(100)
        .safeParse(result);

      if (parsed.success && parsed.data.length === frames.length) {
        resolve(parsed.data);
      } else {
        reject(new Error("source_map_invalid"));
      }
    };
    const timer = setTimeout(() => finish(), 5000);

    worker.once("message", (result: { ok?: boolean; frames?: unknown }) =>
      finish(result.ok ? result.frames : undefined),
    );
    worker.once("error", () => finish());
    worker.once("exit", () => finish());
  });
}
