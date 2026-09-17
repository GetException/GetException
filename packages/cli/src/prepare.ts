import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  artifactPathSchema,
  releaseNameSchema,
  SOURCE_MAP_LIMITS,
  sourceUploadSchema,
  type SourceUpload,
} from "@getexception/protocol";

export function checksum(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function regular(path: string, max: number) {
  const info = await lstat(path);

  if (!info.isFile() || info.size > max) {
    throw new Error("Expected a bounded regular file");
  }

  return readFile(path);
}

async function files(
  root: string,
  directory = root,
  result: string[] = [],
): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error("Build directory must not contain symlinks");
    }

    if (entry.isDirectory()) {
      await files(root, join(directory, entry.name), result);
    } else if (entry.isFile() && /\.(?:m?js)\.map$/.test(entry.name)) {
      result.push(relative(root, join(directory, entry.name)));
    }

    if (result.length > SOURCE_MAP_LIMITS.files) {
      throw new Error("Too many source maps");
    }
  }

  return result;
}

export async function prepareMaps(
  directory: string,
  output: string,
  release: string,
  prefix = "",
) {
  const root = await realpath(directory);
  const destination = join(
    await realpath(dirname(resolve(output))),
    basename(output),
  );
  const child = relative(root, destination);

  releaseNameSchema.parse(release);

  if (
    !child ||
    (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
  ) {
    throw new Error(
      "Private artifacts must be outside the public build directory",
    );
  }

  if (!(await lstat(root)).isDirectory()) {
    throw new Error("Invalid build directory");
  }

  const paths = await files(root);

  if (!paths.length) {
    throw new Error(
      "No source maps found. Enable external/hidden source maps and run prepare once after building",
    );
  }

  const prepared: {
    mapPath: string;
    jsPath: string;
    bytes: Buffer;
    js: string;
    entry: SourceUpload["artifacts"][number];
  }[] = [];
  let total = 0;

  for (const mapPath of paths.sort()) {
    const jsPath = mapPath.slice(0, -4);
    const path = artifactPathSchema.parse(
      [prefix.replace(/^\/+|\/+$/g, ""), jsPath.split(sep).join("/")]
        .filter(Boolean)
        .join("/"),
    );
    const map = JSON.parse(
      (
        await regular(join(root, mapPath), SOURCE_MAP_LIMITS.fileBytes)
      ).toString("utf8"),
    ) as Record<string, unknown>;
    const source = (
      await regular(join(root, jsPath), SOURCE_MAP_LIMITS.fileBytes)
    ).toString("utf8");

    if (
      map.version !== 3 ||
      typeof map.mappings !== "string" ||
      map.sections ||
      map.debug_id ||
      source.startsWith(
        ";(globalThis.__GETEXCEPTION_DEBUG_IDS__??=Object.create(null))",
      )
    ) {
      throw new Error("Expected a fresh, non-indexed v3 source map");
    }

    // Include both inputs and the path: changed mappings must never reuse an ID.
    const hash = createHash("sha256")
      .update(JSON.stringify(["getexception-map-v1", path, source, map]))
      .digest("hex");
    const debugId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${((parseInt(hash[16]!, 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;

    // One injected line: shift generated mappings by exactly one line.
    map.mappings = ";" + map.mappings;
    map.debug_id = debugId;
    map.file = path;
    const bytes = Buffer.from(JSON.stringify(map));
    const entry = {
      path,
      debugId,
      size: bytes.length,
      sha256: checksum(bytes),
    };

    total += bytes.length;

    if (
      bytes.length > SOURCE_MAP_LIMITS.fileBytes ||
      total > SOURCE_MAP_LIMITS.releaseBytes
    ) {
      throw new Error("Source map size limit exceeded");
    }

    // Keep newline/column positions when removing the public map reference.
    const body = source.replace(
      /(?:^|\n)[ \t]*(?:\/\/[#@][ \t]*sourceMappingURL=[^\r\n]*|\/\*[#@][ \t]*sourceMappingURL=[^\r\n]*?\*\/)[ \t]*(?:\r?\n)?$/,
      (comment) => comment.replace(/[^\r\n]/g, " "),
    );
    const js = `;(globalThis.__GETEXCEPTION_DEBUG_IDS__??=Object.create(null))[import.meta.url]=${JSON.stringify(debugId)};\n${body}`;

    prepared.push({ mapPath, jsPath, bytes, js, entry });
  }

  const manifest = sourceUploadSchema.parse({
    release,
    artifacts: prepared.map((item) => item.entry),
  });

  // Never overwrite an older prepared release: it is the retry artifact.
  await mkdir(destination, { mode: 0o700 });

  for (const item of prepared) {
    await writeFile(join(destination, `${item.entry.sha256}.map`), item.bytes, {
      mode: 0o600,
      flag: "wx",
    });
  }

  await writeFile(
    join(destination, "manifest.json"),
    JSON.stringify(manifest),
    { mode: 0o600, flag: "wx" },
  );

  for (const item of prepared) {
    const jsPath = join(root, item.jsPath);
    const temporary = `${jsPath}.${randomUUID()}.tmp`;

    await writeFile(temporary, item.js, { flag: "wx" });
    await rename(temporary, jsPath);
    await unlink(join(root, item.mapPath));
  }

  return manifest;
}

export async function readPrepared(directory: string) {
  return sourceUploadSchema.parse(
    JSON.parse(
      (
        await regular(
          join(directory, "manifest.json"),
          SOURCE_MAP_LIMITS.manifestBytes,
        )
      ).toString("utf8"),
    ),
  );
}

export async function readPreparedMap(
  directory: string,
  entry: SourceUpload["artifacts"][number],
) {
  const bytes = await regular(
    join(directory, `${entry.sha256}.map`),
    SOURCE_MAP_LIMITS.fileBytes,
  );

  if (bytes.length !== entry.size || checksum(bytes) !== entry.sha256) {
    throw new Error("Private artifact checksum mismatch");
  }

  return bytes;
}
