import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { brotliDecompress, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { parse } from "acorn";
import postcss from "postcss";

const gunzipAsync = promisify(gunzip);
const brotliAsync = promisify(brotliDecompress);
const maxPublicFileBytes = 128 * 1024 * 1024;
const inlineMap = /[#@]\s*sourceMappingURL\s*=\s*data:/i;
const debugHeader =
  ";(globalThis.__GETEXCEPTION_DEBUG_IDS__??=Object.create(null))";

export async function listPublicFiles(
  root: string,
  directory = root,
): Promise<string[]> {
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error("Public output must be a directory");
  }

  const paths: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);

    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      throw new Error("Public output must contain only regular files");
    }

    if (/^\.getexception-(?:maps|work)$/.test(entry.name)) {
      throw new Error("Private source map directory in public output");
    }

    if (entry.isDirectory()) {
      paths.push(...(await listPublicFiles(root, file)));
    } else {
      paths.push(file);
    }
  }

  return paths;
}

function hasInlineMap(source: string, extension: string) {
  if (!inlineMap.test(source)) {
    return false;
  }

  if (extension === ".css") {
    let found = false;

    postcss.parse(source, { map: false }).walkComments((comment) => {
      found ||= inlineMap.test(comment.text);
    });

    return found;
  }

  let found = false;

  parse(source, {
    ecmaVersion: "latest",
    sourceType: extension === ".cjs" ? "script" : "module",
    onComment: (_block, comment) => {
      found ||= inlineMap.test(comment);
    },
  });

  return found;
}

export async function assertPublicOutput(
  root: string,
  options: {
    assetPrefix?: string;
    credentials?: string[];
    mapsEnabled?: boolean;
  } = {},
) {
  for (const file of await listPublicFiles(root)) {
    const name = file.replace(/\.(?:gz|br)$/i, "");
    const extension = extname(name).toLowerCase();
    const relativePath = relative(root, file).split(sep).join("/");

    if (/\.map$/i.test(name)) {
      throw new Error("Source map in public output");
    }

    if (
      options.assetPrefix &&
      [".js", ".mjs", ".cjs"].includes(extension) &&
      !relativePath.startsWith(options.assetPrefix)
    ) {
      throw new Error("Public JavaScript outside verified asset prefix");
    }

    const info = await lstat(file);

    if (!info.isFile() || info.size > maxPublicFileBytes) {
      throw new Error("Unverifiable public output file");
    }

    let bytes = await readFile(file);

    if (/\.gz$/i.test(file)) {
      bytes = await gunzipAsync(bytes, { maxOutputLength: maxPublicFileBytes });
    } else if (/\.br$/i.test(file)) {
      bytes = await brotliAsync(bytes, { maxOutputLength: maxPublicFileBytes });
    }

    const source = bytes.toString("utf8");

    if (
      options.credentials?.some(
        (credential) => credential && source.includes(credential),
      ) ||
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(source)
    ) {
      throw new Error("Credential in public output");
    }

    if (basename(name) === "release.json") {
      throw new Error("Private release metadata in public output");
    }

    if (extension === ".json") {
      const value = JSON.parse(source) as Record<string, unknown>;

      if (value.release && Array.isArray(value.artifacts)) {
        throw new Error("Source map manifest in public output");
      }
    }

    if (
      [".js", ".mjs", ".cjs", ".css"].includes(extension)
        ? hasInlineMap(source, extension)
        : inlineMap.test(source)
    ) {
      throw new Error("Inline source map in public output");
    }

    if (
      !options.mapsEnabled &&
      [".js", ".mjs"].includes(extension) &&
      source.startsWith(debugHeader)
    ) {
      throw new Error("Prepared JavaScript in build without source maps");
    }
  }
}
