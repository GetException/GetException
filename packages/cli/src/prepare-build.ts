import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { SOURCE_MAP_LIMITS } from "@getexception/protocol";
import { prepareMaps } from "./prepare";
import { listPublicFiles } from "./public-output";

const maxBuildMaps = 4096;

export async function prepareBuild(
  output: string,
  privateRoot: string,
  release: string,
  signal: AbortSignal = AbortSignal.timeout(5 * 60_000),
) {
  signal.throwIfAborted();
  const paths = await listPublicFiles(output);
  const maps = paths.filter((file) => /\.(?:m?js)\.map$/i.test(file)).sort();

  if (
    !maps.length ||
    maps.length > maxBuildMaps ||
    paths.some(
      (file) => /\.map(?:\.(?:gz|br))?$/i.test(file) && !maps.includes(file),
    ) ||
    paths.some((file) => /\.(?:gz|br)$/i.test(file))
  ) {
    throw new Error("Expected fresh uncompressed JavaScript source maps");
  }

  const batches: string[][] = [];
  let batchBytes = 0;
  let totalBytes = 0;

  for (const map of maps) {
    signal.throwIfAborted();
    const js = map.slice(0, -4);
    const [mapInfo, jsInfo] = await Promise.all([stat(map), stat(js)]);
    const bytes = mapInfo.size + 4096;

    if (
      !mapInfo.isFile() ||
      !jsInfo.isFile() ||
      bytes > SOURCE_MAP_LIMITS.fileBytes ||
      jsInfo.size > SOURCE_MAP_LIMITS.fileBytes
    ) {
      throw new Error("Oversized source map or JavaScript");
    }

    if (
      !batches.length ||
      batches[batches.length - 1]!.length >= SOURCE_MAP_LIMITS.files ||
      batchBytes + bytes > SOURCE_MAP_LIMITS.releaseBytes
    ) {
      batches.push([]);
      batchBytes = 0;
    }

    batches[batches.length - 1]!.push(map);
    batchBytes += bytes;
    totalBytes += bytes;
  }

  if (totalBytes > SOURCE_MAP_LIMITS.projectBytes) {
    throw new Error("Build exceeds project source map quota");
  }

  const work = join(privateRoot, "work");
  const privateMaps = join(privateRoot, "maps");

  await mkdir(work, { mode: 0o700 });
  await mkdir(privateMaps, { mode: 0o700 });
  const prepared: { from: string; to: string }[] = [];

  for (const [index, batch] of batches.entries()) {
    signal.throwIfAborted();
    const name = `batch-${String(index + 1).padStart(3, "0")}`;
    const staging = join(work, name);
    const destination = join(privateMaps, name);

    await mkdir(staging, { mode: 0o700 });

    for (const map of batch) {
      for (const file of [map, map.slice(0, -4)]) {
        signal.throwIfAborted();
        const copy = join(staging, relative(output, file));

        await mkdir(dirname(copy), { recursive: true, mode: 0o700 });
        await copyFile(file, copy);
      }
    }

    await prepareMaps(staging, destination, release);
    signal.throwIfAborted();

    for (const map of batch) {
      const js = map.slice(0, -4);

      prepared.push({ from: join(staging, relative(output, js)), to: js });
    }
  }

  // Prepare every batch privately before changing public JavaScript. A failed
  // commit still requires a clean build without maps before deployment.
  for (const { from, to } of prepared) {
    signal.throwIfAborted();
    const temporary = `${to}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporary, await readFile(from, { signal }), {
        flag: "wx",
        signal,
      });
      signal.throwIfAborted();
      await rename(temporary, to);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  for (const map of maps) {
    signal.throwIfAborted();

    if (!(await lstat(map)).isFile()) {
      throw new Error("Source map changed during preparation");
    }

    await unlink(map);
  }

  return privateMaps;
}
