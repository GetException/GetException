import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { uploadMaps } from "../../packages/cli/src/upload";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("uploads a full source map batch with bounded parallel requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "getexception-upload-"));
  const bytes = Buffer.from("{}");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifacts = Array.from({ length: 128 }, (_, index) => ({
    path: `assets/chunk-${index}.js`,
    debugId: randomUUID(),
    sha256,
    size: bytes.length,
  }));
  const uploadId = randomUUID();
  let active = 0;
  let maximum = 0;
  let uploads = 0;

  directories.push(directory);
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ release: `account@${"a".repeat(40)}`, artifacts }),
  );
  await writeFile(join(directory, `${sha256}.map`), bytes);

  await uploadMaps(
    directory,
    "https://monitor.example.test",
    randomUUID(),
    "a".repeat(64),
    async (address, options) => {
      const request = new Request(String(address), options);
      const parts = new URL(String(address)).pathname
        .split("/source-maps")[1]!
        .split("/")
        .filter(Boolean);

      if (!parts.length) {
        return Response.json({
          uploadId,
          status: "receiving",
          artifacts: artifacts.map((artifact) => ({
            id: randomUUID(),
            path: artifact.path,
            uploaded: false,
          })),
        });
      }

      if (request.method === "PUT") {
        active += 1;
        uploads += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;

        return Response.json({ ok: true });
      }

      return Response.json({
        status: request.method === "POST" ? "pending" : "ready",
      });
    },
  );

  expect(uploads).toBe(128);
  expect(maximum).toBe(8);
});
