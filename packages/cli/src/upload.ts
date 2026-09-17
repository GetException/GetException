import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { readPrepared, readPreparedMap } from "./prepare";
import { projectApi } from "./api";

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

export async function uploadMaps(
  directory: string,
  address: string,
  project: string,
  token: string,
  transport: typeof fetch = fetch,
) {
  const manifest = await readPrepared(directory);
  const api = projectApi(address, project, token, transport);
  const request = (path: string, method = "GET", body?: string | Uint8Array) =>
    api("/source-maps" + path, method, body);

  const receipt = receiptSchema.parse(
    await request("", "POST", JSON.stringify(manifest)),
  );

  if (receipt.status === "ready") {
    return;
  }

  if (receipt.status === "receiving") {
    for (const entry of manifest.artifacts) {
      const remote = receipt.artifacts.find((item) => item.path === entry.path);

      if (!remote) {
        throw new Error("Incomplete upload receipt");
      }

      if (remote.uploaded) {
        continue;
      }

      await request(
        `/${receipt.uploadId}/${remote.id}`,
        "PUT",
        await readPreparedMap(directory, entry),
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
