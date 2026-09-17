import type { Database } from "@getexception/db";
import { SourceMapStore } from "@getexception/source-maps";
import type { OriginalFrame, SafeEvent } from "@getexception/protocol";
import { parseStoredMap } from "./parse";

export async function resolveFrames(
  db: Database,
  projectId: string,
  event: SafeEvent,
  store = new SourceMapStore(),
) {
  const originalFrames: (OriginalFrame | null)[] = event.frames.map(() => null);
  const release = event.release
    ? await db.release.findUnique({
        where: { projectId_name: { projectId, name: event.release } },
      })
    : null;
  let failed = false;

  if (release?.sourceMapsVersion) {
    const groups = new Map<
      string,
      {
        indexes: number[];
        file: NonNullable<
          Awaited<ReturnType<typeof db.sourceArtifact.findFirst>>
        >;
      }
    >();

    for (const [index, frame] of event.frames.entries()) {
      const candidates = await db.sourceArtifact.findMany({
        where: {
          projectId,
          release: event.release,
          upload: { status: "ready" },
          ...(frame.debug_id
            ? { debugId: frame.debug_id }
            : { path: frame.filename.replace(/^\//, "") }),
        },
        distinct: ["sha256"],
        take: 2,
      });

      if (candidates.length !== 1) {
        continue;
      }

      const file = candidates[0]!;
      const group = groups.get(file.id) ?? { indexes: [], file };

      group.indexes.push(index);
      groups.set(file.id, group);
    }

    for (const { indexes, file } of groups.values()) {
      try {
        const result = await parseStoredMap(
          store,
          file,
          indexes.map((index) => event.frames[index]!),
        );

        result.forEach((frame, offset) => {
          originalFrames[indexes[offset]!] = frame;
        });
      } catch {
        failed = true;
      }
    }
  }

  const count = originalFrames.filter(Boolean).length;

  return {
    originalFrames,
    version: release?.sourceMapsVersion ?? 0,
    state: count
      ? count === event.frames.length
        ? "complete"
        : "partial"
      : failed
        ? "failed"
        : "missing",
    event: {
      ...event,
      frames: event.frames.map((frame, index) => {
        const original = originalFrames[index];

        return original
          ? {
              ...frame,
              filename: original.filename,
              function: original.function,
              lineno: original.lineno,
              colno: original.colno,
            }
          : frame;
      }),
    },
  };
}
