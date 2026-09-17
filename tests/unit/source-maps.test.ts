import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parseSourceMap } from "../../apps/worker/src/source-maps/parse";
import { prepareMaps } from "../../packages/cli/src/prepare";
import { SourceMapStore } from "@getexception/source-maps";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

it("prepares a private artifact and symbolicates the shifted generated line in an isolated worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "getexception-maps-"));

  directories.push(root);
  const dist = join(root, "dist");
  const output = join(root, "private");

  await mkdir(dist);
  await writeFile(
    join(dist, "app.js"),
    'throw new Error("sample");\nconst sdkRegistry = "__GETEXCEPTION_DEBUG_IDS__"; const example = "//# sourceMappingURL=inline";\n//# sourceMappingURL=app.js.map',
  );
  await writeFile(
    join(dist, "app.js.map"),
    JSON.stringify({
      version: 3,
      file: "app.js",
      sources: ["../src/app.ts"],
      names: ["originalFunction"],
      mappings: "AAAAA",
      sourcesContent: ['throw new Error("sample");\n// next line'],
    }),
  );
  const manifest = await prepareMaps(dist, output, `account@${"a".repeat(40)}`);
  const artifact = manifest.artifacts[0]!;
  const map = await readFile(join(output, `${artifact.sha256}.map`), "utf8");

  expect(await readFile(join(dist, "app.js"), "utf8")).toContain(
    artifact.debugId,
  );
  expect(await readFile(join(dist, "app.js"), "utf8")).toContain(
    'const example = "//# sourceMappingURL=inline";',
  );
  await expect(readFile(join(dist, "app.js.map"))).rejects.toThrow();
  const frames = await parseSourceMap(map, artifact.debugId, artifact.path, [
    { filename: "/app.js", function: "x", lineno: 2, colno: 1, in_app: true },
  ]);

  expect(frames[0]).toMatchObject({
    filename: "src/app.ts",
    function: "originalFunction",
    lineno: 1,
    colno: 1,
    contextLine: 'throw new Error("sample");',
    postContext: ["// next line"],
  });
  await expect(
    parseSourceMap(map, randomUUID(), artifact.path),
  ).rejects.toThrow("source_map_invalid");
  await expect(
    parseSourceMap('{"__proto__":{}}', artifact.debugId, artifact.path),
  ).rejects.toThrow();
  expect(await parseSourceMap(map, artifact.debugId, artifact.path)).toEqual(
    [],
  );
});

it("prevents public artifact output and arbitrary store paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "getexception-maps-"));

  directories.push(root);
  await expect(
    prepareMaps(root, join(root, "maps"), `account@${"a".repeat(40)}`),
  ).rejects.toThrow("outside");
  const store = new SourceMapStore(root);

  await expect(store.write("../outside", Buffer.from("{}"))).rejects.toThrow();
  expect(await store.read(randomUUID()).catch(() => null)).toBeNull();
});

it("reuses IDs only for identical JS, maps and paths across releases", async () => {
  const root = await mkdtemp(join(tmpdir(), "getexception-map-identity-"));

  directories.push(root);

  async function prepare(
    name: string,
    sha: string,
    js = "throw 1;",
    original = "throw 1;",
  ) {
    const dist = join(root, name);

    await mkdir(dist);
    await writeFile(join(dist, "app.js"), js);
    await writeFile(
      join(dist, "app.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["app.ts"],
        names: [],
        mappings: "AAAA",
        sourcesContent: [original],
      }),
    );

    return (
      await prepareMaps(
        dist,
        join(root, name + "-private"),
        `account@${sha.repeat(40)}`,
      )
    ).artifacts[0]!;
  }

  const first = await prepare("first", "a");

  expect(await prepare("second", "b")).toEqual(first);
  expect((await prepare("changed-js", "c", "throw 2;")).debugId).not.toBe(
    first.debugId,
  );
  expect(
    (await prepare("changed-map", "d", "throw 1;", "// original changed"))
      .debugId,
  ).not.toBe(first.debugId);
});
