import { z } from "zod";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { constants, gzip } from "node:zlib";
import { readPrepared, readPreparedMap } from "./prepare";
import { projectApi } from "./api";
import type { CiCredential } from "./credentials";

const receiptSchema = z.object({
  uploadId: z.string().uuid(),
  status: z.string(),
  artifacts: z.array(
    z.object({
      id: z.string().uuid(),
      path: z.string(),
      uploaded: z.boolean().optional(),
    }),
  ),
});

const uploadConcurrency = 8;
const uploadDeadlineMs = 20 * 60_000;
const gzipAsync = promisify(gzip);

export async function uploadMaps(
  directory: string,
  address: string,
  project: string,
  token: CiCredential,
  transport: typeof fetch = fetch,
) {
  const manifest = await readPrepared(directory);
  const api = projectApi(address, project, token, transport, {
    deadlineMs: uploadDeadlineMs,
    requestTimeoutMs: 60_000,
  });
  const request = (
    path: string,
    method = "GET",
    body?: string | Uint8Array,
    contentEncoding?: "gzip",
  ) => api("/source-maps" + path, method, body, contentEncoding);

  const receipt = receiptSchema.parse(
    await request("", "POST", JSON.stringify(manifest)),
  );

  if (receipt.status === "ready") {
    return;
  }

  if (receipt.status === "receiving") {
    const pending: {
      entry: (typeof manifest.artifacts)[number];
      id: string;
    }[] = [];

    for (const entry of manifest.artifacts) {
      const remote = receipt.artifacts.find((item) => item.path === entry.path);

      if (!remote) {
        throw new Error("Incomplete upload receipt");
      }

      if (remote.uploaded) {
        continue;
      }

      pending.push({ entry, id: remote.id });
    }

    for (let start = 0; start < pending.length; start += uploadConcurrency) {
      const group = pending.slice(start, start + uploadConcurrency);

      // Keep each wave bounded so a failed request stops before more files start.
      await Promise.all(
        group.map(async ({ entry, id }) => {
          const bytes = await readPreparedMap(directory, entry);
          const compressed = await gzipAsync(bytes, {
            level: constants.Z_BEST_SPEED,
          });

          return request(
            `/${receipt.uploadId}/${id}`,
            "PUT",
            compressed,
            "gzip",
          );
        }),
      );
    }

    await request(`/${receipt.uploadId}`, "POST");
  }

  for (;;) {
    const result = z
      .object({ status: z.string() })
      .parse(await request(`/${receipt.uploadId}`));

    if (result.status === "ready") {
      return;
    }

    if (result.status === "failed") {
      throw new Error("Source map validation failed; rebuild the artifacts");
    }

    await delay(1000);
  }
}
