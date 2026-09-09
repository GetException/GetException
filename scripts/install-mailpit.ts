import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const version = "1.31.1";
const checksums: Record<string, string> = {
  "darwin-amd64":
    "fdb79c830121eba42d6ed051d7837a50bc8fe9e527db6ae44f974ce835ce5eab",
  "darwin-arm64":
    "71c10f33f36c78a2864c4df906f11736b092a80ad1371742bd4e90e65d778e1b",
  "linux-amd64":
    "87d2652abd7c17dc99029147ff62ac671afdf7fd76630f7faf5b14125211c709",
  "linux-arm64":
    "be6a1f9dcf0ac0d7157ee777eac2b5351352b367bcae3c0a0f4854da60546884",
};
const platform = `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
const expected = checksums[platform];

if (!expected) {
  throw new Error(
    "Provide MAILPIT_BINARY for this platform; see docs/local-preview.md.",
  );
}

const directory = resolve(".artifacts/tools");

mkdirSync(directory, { recursive: true, mode: 0o700 });
const archive = resolve(directory, "mailpit.tar.gz");
let bytes = existsSync(archive) ? readFileSync(archive) : undefined;

if (!bytes || createHash("sha256").update(bytes).digest("hex") !== expected) {
  const response = await fetch(
    `https://github.com/axllent/mailpit/releases/download/v${version}/mailpit-${platform}.tar.gz`,
    { signal: AbortSignal.timeout(60_000) },
  );

  if (!response.ok) {
    throw new Error("Mailpit download failed.");
  }

  bytes = Buffer.from(await response.arrayBuffer());
}

if (createHash("sha256").update(bytes).digest("hex") !== expected) {
  throw new Error("Mailpit checksum mismatch.");
}

writeFileSync(archive, bytes, { mode: 0o600 });
// Read only the pinned binary entry; never extract arbitrary archive paths.
const extracted = spawnSync("tar", ["-xOf", archive, "mailpit"], {
  maxBuffer: 100 * 1024 * 1024,
});

if (extracted.status !== 0 || !extracted.stdout.length) {
  throw new Error("Unable to extract Mailpit.");
}

const staging = resolve(directory, "mailpit.next");

writeFileSync(staging, extracted.stdout, { mode: 0o700 });
chmodSync(staging, 0o700);
renameSync(staging, resolve(directory, "mailpit"));
unlinkSync(archive);
process.stdout.write(`Mailpit ${version} is ready for yarn local:start.\n`);
