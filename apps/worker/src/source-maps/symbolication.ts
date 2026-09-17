import { parentPort, workerData } from "node:worker_threads";
import {
  TraceMap,
  decodedMappings,
  originalPositionFor,
  sourceContentFor,
} from "@jridgewell/trace-mapping";
import {
  originalFrameSchema,
  type OriginalFrame,
  type SafeFrame,
} from "@getexception/protocol";

type Task = {
  text: string;
  debugId: string;
  path: string;
  frames: SafeFrame[];
};

function processMap({
  text,
  debugId,
  path,
  frames,
}: Task): (OriginalFrame | null)[] {
  const input = JSON.parse(text, (key, value: unknown) => {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new Error("Invalid map");
    }

    return value;
  });

  if (
    !input ||
    input.version !== 3 ||
    input.sections !== undefined ||
    input.debug_id !== debugId ||
    input.file !== path ||
    typeof input.mappings !== "string" ||
    !Array.isArray(input.sources) ||
    !Array.isArray(input.names) ||
    input.sources.length > 100_000 ||
    input.names.length > 100_000 ||
    !input.sources.every(
      (source: unknown) => typeof source === "string" && source.length <= 4096,
    ) ||
    !input.names.every(
      (name: unknown) => typeof name === "string" && name.length <= 4096,
    ) ||
    (input.sourceRoot !== undefined &&
      (typeof input.sourceRoot !== "string" ||
        input.sourceRoot.length > 4096)) ||
    (input.sourcesContent !== undefined &&
      (!Array.isArray(input.sourcesContent) ||
        input.sourcesContent.length !== input.sources.length ||
        !input.sourcesContent.every(
          (source: unknown) => source === null || typeof source === "string",
        )))
  ) {
    throw new Error("Invalid map");
  }

  const map = new TraceMap(input);
  let count = 0;

  for (const line of decodedMappings(map)) {
    let previous = -1;

    for (const segment of line) {
      if (
        ++count > 1_000_000 ||
        ![1, 4, 5].includes(segment.length) ||
        segment[0] < previous
      ) {
        throw new Error("Invalid mappings");
      }

      previous = segment[0];

      if (
        segment.length >= 4 &&
        (segment[1]! < 0 ||
          segment[1]! >= input.sources.length ||
          segment[2]! < 0 ||
          segment[2]! > 10_000_000 ||
          segment[3]! < 0 ||
          segment[3]! > 10_000_000)
      ) {
        throw new Error("Invalid mappings");
      }

      if (
        segment.length === 5 &&
        (segment[4]! < 0 || segment[4]! >= input.names.length)
      ) {
        throw new Error("Invalid mappings");
      }
    }
  }

  const contents = new Map<string, string[]>();

  return frames.map((frame) => {
    if (frame.lineno < 1) {
      return null;
    }

    // Browser stack columns are one-based; source maps use zero-based columns.
    const position = originalPositionFor(map, {
      line: frame.lineno,
      column: Math.max(0, frame.colno - 1),
    });

    if (
      position.source === null ||
      position.line === null ||
      position.column === null
    ) {
      return null;
    }

    let lines = contents.get(position.source);

    if (!lines) {
      const source = sourceContentFor(map, position.source);

      lines = source?.split(/\r?\n/) ?? [];
      contents.set(position.source, lines);
    }

    const filename = position.source
      .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i, "")
      .replace(/^(?:\.\.?\/)+/, "")
      .split(/[?#]/)[0]!
      .slice(0, 512);
    const trim = (line: string) =>
      line.replaceAll(String.fromCharCode(0), "").slice(0, 2000);

    return originalFrameSchema.parse({
      filename,
      function: (position.name ?? frame.function).slice(0, 160),
      lineno: position.line,
      colno: position.column + 1,
      contextLine:
        lines[position.line - 1] === undefined
          ? undefined
          : trim(lines[position.line - 1]!),
      preContext: lines
        .slice(Math.max(0, position.line - 4), position.line - 1)
        .map(trim),
      postContext: lines.slice(position.line, position.line + 3).map(trim),
    });
  });
}

try {
  parentPort?.postMessage({ ok: true, frames: processMap(workerData as Task) });
} catch {
  parentPort?.postMessage({ ok: false });
}
