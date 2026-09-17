import { constants } from "node:fs";
import { mkdir, open, rename, unlink, lstat, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { SOURCE_MAP_LIMITS } from "@getexception/protocol";

export class SourceMapStore {
  readonly root: string;

  constructor(root = process.env.SOURCE_MAP_DIR ?? ".local/source-maps") {
    this.root = resolve(root);
  }

  private path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) {
      throw new Error("Invalid artifact identifier");
    }

    return join(this.root, `${id}.map`);
  }

  async write(id: string, bytes: Uint8Array) {
    if (bytes.length > SOURCE_MAP_LIMITS.fileBytes) {
      throw new Error("Artifact too large");
    }

    await mkdir(this.root, { recursive: true, mode: 0o700 });

    if (!(await lstat(this.root)).isDirectory()) {
      throw new Error("Invalid artifact storage");
    }

    const temporary = join(this.root, `${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );

    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await rename(temporary, this.path(id));
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});

      throw error;
    }
  }

  async read(id: string): Promise<Buffer> {
    const handle = await open(
      this.path(id),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );

    try {
      const stat = await handle.stat();

      if (!stat.isFile() || stat.size > SOURCE_MAP_LIMITS.fileBytes) {
        throw new Error("Invalid artifact");
      }

      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async exists(id: string) {
    try {
      const stat = await lstat(this.path(id));

      return stat.isFile() && stat.size <= SOURCE_MAP_LIMITS.fileBytes;
    } catch {
      return false;
    }
  }

  async remove(id: string) {
    await unlink(this.path(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }

  async entries() {
    try {
      return (await readdir(this.root, { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isFile() && /^[a-f0-9-]{36}\.(map|tmp)$/.test(entry.name),
        )
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async removeOrphan(name: string, before: Date) {
    if (!/^[a-f0-9-]{36}\.(map|tmp)$/.test(name)) {
      return;
    }

    const path = join(this.root, name);
    const stat = await lstat(path).catch(() => undefined);

    if (stat?.isFile() && stat.mtime < before) {
      await unlink(path).catch(() => {});
    }
  }
}
