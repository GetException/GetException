import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFile, mkdir, readFile, symlink } from "node:fs/promises";
import { createDatabase } from "@getexception/db";
import { sanitizeEvent } from "@getexception/protocol";
import { SourceMapStore } from "@getexception/source-maps";
import { temporaryDatabase } from "./database";
import { createRuntime } from "../../apps/web/src/server/runtime";
import { digest, token } from "../../apps/web/src/server/crypto";
import {
  authorizeUpload,
  beginUpload,
  uploadArtifact,
  finishUpload,
  uploadStatus,
  checkUploadRequest,
} from "../../apps/web/src/server/source-maps/upload";
import { createSourceMapToken } from "../../apps/web/src/server/source-maps/tokens";
import { claim, processJob } from "../../apps/worker/src/events";
import { validateOneUpload } from "../../apps/worker/src/source-maps/uploads";
import { reprocessOneEvent } from "../../apps/worker/src/source-maps/reprocess";
import { retainSourceMaps } from "../../apps/worker/src/source-maps/retention";
import { prepareMaps, readPreparedMap } from "../../packages/cli/src/prepare";
import { uploadMaps } from "../../packages/cli/src/upload";

let instance: Awaited<ReturnType<typeof temporaryDatabase>>;
let web: ReturnType<typeof createDatabase>;
let worker: ReturnType<typeof createDatabase>;
let service: ReturnType<typeof createRuntime>["service"];
let store: SourceMapStore;
let projectId: string;
const secret = token();
const headers = new Headers({
  authorization: `Bearer ${secret}`,
  "x-real-ip": "integration",
});
const release = `account@${"b".repeat(40)}`;

beforeAll(async () => {
  instance = await temporaryDatabase();
  web = createDatabase(instance.urls.web);
  worker = createDatabase(instance.urls.worker);
  store = new SourceMapStore(join(instance.directory, "source-maps"));
  service = createRuntime(
    {
      DATABASE_URL: instance.urls.web,
      DASHBOARD_ORIGIN: "https://monitor.example.test",
      INGEST_ORIGIN: "https://ingest.example.test",
      BETTER_AUTH_SECRET: token(),
      TOTP_ENCRYPTION_KEY: token(),
      AUTH_RATE_KEY: token(),
      MAIL_ENCRYPTION_KEY: token(),
      MAIL_ENABLED: false,
    },
    web,
  ).service;
  const organization = await instance.admin.organization.create({
    data: { id: randomUUID(), name: "Test", slug: "maps" },
  });
  const project = await instance.admin.project.create({
    data: { organizationId: organization.id, name: "Account", slug: "account" },
  });

  projectId = project.id;
  await instance.admin.systemSetting.create({
    data: { domain: "monitor.example.test" },
  });
  await instance.admin.sourceMapToken.create({
    data: {
      projectId,
      name: "CI",
      tokenHash: digest(secret),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
});

afterAll(async () => {
  await Promise.all([web?.$disconnect(), worker?.$disconnect()]);
  await instance?.cleanup();
});

async function insertEvent(debugId?: string) {
  const eventId = randomUUID().replaceAll("-", "");
  const event = sanitizeEvent(
    {
      message: "Map regression",
      release,
      contexts: {
        api: {
          code: "error.request",
          reason: "server_error",
          status_code: 503,
        },
        browser: { name: "Firefox", major: 131 },
      },
      exception: {
        values: [
          {
            type: "Error",
            value: "Map regression",
            stacktrace: {
              frames: [
                {
                  filename: "https://app.example.test/app.js",
                  function: "x",
                  lineno: 2,
                  colno: 1,
                  in_app: true,
                  debug_id: debugId,
                },
              ],
            },
          },
        ],
      },
    },
    eventId,
  );

  await instance.admin.eventInbox.create({
    data: { projectId, eventId, receivedAt: new Date(), payload: event },
  });
  const job = await claim(worker);

  expect(job).not.toBeNull();
  await processJob(worker, job!, store);

  return instance.admin.errorEvent.findUniqueOrThrow({
    where: { projectId_eventId: { projectId, eventId } },
  });
}

it("uses scoped CI credentials, rejects session-only uploads and hides artifacts from ingestion", async () => {
  await expect(
    authorizeUpload(
      service,
      new Headers({ cookie: "session=irrelevant" }),
      projectId,
    ),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    authorizeUpload(service, headers, randomUUID()),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    createSourceMapToken(service, new Headers(), projectId, { name: "CI" }),
  ).rejects.toThrow();
  expect(() =>
    checkUploadRequest(new Request("http://example.test/api")),
  ).toThrow();
  expect(() =>
    checkUploadRequest(
      new Request("https://example.test/api", {
        headers: { Origin: "https://example.test" },
      }),
    ),
  ).toThrow();
  const ingest = createDatabase(instance.urls.ingest);

  try {
    await expect(ingest.sourceArtifact.findMany()).rejects.toThrow();
    await expect(ingest.sourceMapToken.findMany()).rejects.toThrow();
    await expect(worker.sourceMapToken.findMany()).rejects.toThrow();
  } finally {
    await ingest.$disconnect();
  }
});

it("uploads privately, publishes atomically and reprocesses old events with audited regrouping", async () => {
  const old = await insertEvent();

  expect(old).toMatchObject({
    apiCode: "error.request",
    apiReason: "server_error",
    httpStatus: 503,
    browserName: "Firefox",
    browserMajor: 131,
    symbolicationState: "missing",
  });
  await instance.admin.issue.update({
    where: { id: old.issueId },
    data: { status: "resolved" },
  });
  const dist = join(instance.directory, "dist");
  const privateDir = join(instance.directory, "private");

  await mkdir(dist);
  await writeFile(join(dist, "app.js"), 'throw new Error("Map regression");');
  await writeFile(
    join(dist, "app.js.map"),
    JSON.stringify({
      version: 3,
      sources: ["src/original.ts"],
      names: ["requestAccount"],
      mappings: "AAAAA",
      sourcesContent: ['throw new Error("Map regression");'],
    }),
  );
  const manifest = await prepareMaps(dist, privateDir, release);
  const receipt = await beginUpload(
    service,
    headers,
    projectId,
    manifest,
    store,
  );
  const artifact = receipt.artifacts[0]!;

  await expect(
    finishUpload(service, headers, projectId, receipt.uploadId),
  ).rejects.toMatchObject({ status: 409 });
  const invalid = new Request("https://monitor.example.test/upload", {
    method: "PUT",
    headers: {
      ...Object.fromEntries(headers),
      "content-type": "application/json",
    },
    body: "{}",
  });

  await expect(
    uploadArtifact(
      service,
      invalid,
      projectId,
      receipt.uploadId,
      artifact.id,
      store,
    ),
  ).rejects.toMatchObject({ status: 400 });
  const bytes = await readPreparedMap(privateDir, manifest.artifacts[0]!);

  await uploadArtifact(
    service,
    new Request("https://monitor.example.test/upload", {
      method: "PUT",
      headers: {
        ...Object.fromEntries(headers),
        "content-type": "application/json",
      },
      body: new Uint8Array(bytes),
    }),
    projectId,
    receipt.uploadId,
    artifact.id,
    store,
  );
  expect(
    (
      await instance.admin.release.findUniqueOrThrow({
        where: { projectId_name: { projectId, name: release } },
      })
    ).sourceMapsState,
  ).toBe("pending");
  await finishUpload(service, headers, projectId, receipt.uploadId);
  expect(await validateOneUpload(worker, store)).toBe(true);
  expect(
    await uploadStatus(service, headers, projectId, receipt.uploadId),
  ).toMatchObject({ status: "ready", errorCode: null });
  expect(await reprocessOneEvent(worker, store)).toBe(true);
  expect(await reprocessOneEvent(worker, store)).toBe(false);
  const mapped = await instance.admin.errorEvent.findUniqueOrThrow({
    where: { id: old.id },
  });

  expect(mapped.symbolicationState).toBe("complete");
  expect(mapped.originalFrames).toMatchObject([
    {
      filename: "src/original.ts",
      function: "requestAccount",
      lineno: 1,
      contextLine: 'throw new Error("Map regression");',
    },
  ]);
  expect(mapped.issueId).not.toBe(old.issueId);
  expect(
    await instance.admin.issue.findUniqueOrThrow({
      where: { id: old.issueId },
    }),
  ).toMatchObject({ eventCount: 0 });
  expect(
    await instance.admin.issue.findUniqueOrThrow({
      where: { id: mapped.issueId },
    }),
  ).toMatchObject({ status: "resolved", regression: false, eventCount: 1 });
  expect(
    await web.issueActivity.count({
      where: { projectId, fromIssueId: old.issueId, toIssueId: mapped.issueId },
    }),
  ).toBe(1);
  const current = await insertEvent(manifest.artifacts[0]!.debugId);

  expect(current).toMatchObject({
    issueId: mapped.issueId,
    symbolicationState: "complete",
  });
  expect(
    await instance.admin.issue.findUniqueOrThrow({
      where: { id: mapped.issueId },
    }),
  ).toMatchObject({ eventCount: 2, regression: true, status: "open" });
  expect(
    (await beginUpload(service, headers, projectId, manifest, store)).uploadId,
  ).toBe(receipt.uploadId);
  const incompatible = {
    ...manifest,
    artifacts: [{ ...manifest.artifacts[0]!, path: "../private.js" }],
  };

  await expect(
    beginUpload(service, headers, projectId, incompatible, store),
  ).rejects.toThrow();
  const stored = await web.sourceArtifact.findUniqueOrThrow({
    where: { id: artifact.id },
  });

  await store.remove(stored.storageId);
  expect(
    (await beginUpload(service, headers, projectId, manifest, store)).status,
  ).toBe("receiving");

  // Run the public CLI transport against the real service methods (no mocked database).
  await uploadMaps(
    privateDir,
    "https://monitor.example.test",
    projectId,
    secret,
    async (url, options) => {
      const path = String(url).split("/source-maps")[1]!;
      const parts = path.split("/").filter(Boolean);
      const request = new Request(String(url), options);
      let result: unknown;

      if (!path) {
        result = await beginUpload(
          service,
          request.headers,
          projectId,
          await request.json(),
          store,
        );
      } else if (options?.method === "PUT") {
        result = await uploadArtifact(
          service,
          request,
          projectId,
          parts[0]!,
          parts[1]!,
          store,
        );
      } else if (options?.method === "POST") {
        result = await finishUpload(
          service,
          request.headers,
          projectId,
          parts[0]!,
        );
        await validateOneUpload(worker, store);
      } else {
        result = await uploadStatus(
          service,
          request.headers,
          projectId,
          parts[0]!,
        );
      }

      return Response.json(result);
    },
  );
  expect(await store.exists(stored.storageId)).toBe(true);
  await expect(readFile(join(dist, "app.js.map"))).rejects.toThrow();
});

it("rejects malformed maps as an entire batch and never exposes partial artifacts", async () => {
  const { checksum } = await import("../../packages/cli/src/prepare");
  const bytes = Buffer.from('{"version":3,"mappings":"AAAA"}');
  const manifest = {
    release,
    artifacts: [
      {
        path: "broken.js",
        debugId: randomUUID(),
        sha256: checksum(bytes),
        size: bytes.length,
      },
    ],
  };
  const receipt = await beginUpload(
    service,
    headers,
    projectId,
    manifest,
    store,
  );

  await uploadArtifact(
    service,
    new Request("https://example.test/upload", {
      method: "PUT",
      headers: {
        ...Object.fromEntries(headers),
        "content-type": "application/json",
      },
      body: new Uint8Array(bytes),
    }),
    projectId,
    receipt.uploadId,
    receipt.artifacts[0]!.id,
    store,
  );
  await finishUpload(service, headers, projectId, receipt.uploadId);
  await validateOneUpload(worker, store);
  expect(
    await uploadStatus(service, headers, projectId, receipt.uploadId),
  ).toMatchObject({ status: "failed", errorCode: "source_map_invalid" });
  expect(
    (
      await web.release.findUniqueOrThrow({
        where: { projectId_name: { projectId, name: release } },
      })
    ).sourceMapsState,
  ).toBe("ready");
});

it("reuses private bytes across releases, rejects conflicting IDs and preserves shared files during retention", async () => {
  const first = await web.sourceArtifact.findFirstOrThrow({
    where: { projectId, upload: { status: "ready" } },
  });
  const nextRelease = `account@${"c".repeat(40)}`;
  const input = {
    release: nextRelease,
    artifacts: [
      {
        path: first.path,
        debugId: first.debugId,
        sha256: first.sha256,
        size: first.size,
      },
    ],
  };
  const filesBefore = await store.entries();
  const receipt = await beginUpload(service, headers, projectId, input, store);

  expect(receipt.artifacts[0]?.uploaded).toBe(true);
  const reference = await web.sourceArtifact.findUniqueOrThrow({
    where: { id: receipt.artifacts[0]!.id },
  });

  expect(reference.storageId).toBe(first.storageId);
  await finishUpload(service, headers, projectId, receipt.uploadId);
  await validateOneUpload(worker, store);
  expect(
    await uploadStatus(service, headers, projectId, receipt.uploadId),
  ).toMatchObject({ status: "ready" });
  expect(await store.entries()).toEqual(filesBefore);
  await expect(
    beginUpload(
      service,
      headers,
      projectId,
      {
        ...input,
        artifacts: [{ ...input.artifacts[0], sha256: "f".repeat(64) }],
      },
      store,
    ),
  ).rejects.toMatchObject({ status: 409 });
  await instance.admin.sourceMapUpload.update({
    where: { id: receipt.uploadId },
    data: { createdAt: new Date(0) },
  });
  await retainSourceMaps(worker, store);
  expect(
    await web.sourceMapUpload.findUnique({ where: { id: receipt.uploadId } }),
  ).toBeNull();
  expect(await store.exists(first.storageId)).toBe(true);
  expect((await insertEvent(first.debugId)).symbolicationState).toBe(
    "complete",
  );
});

it("registers MR metadata only through scoped CI authentication and preserves observed environments", async () => {
  const { registerRelease } =
    await import("../../apps/web/src/server/releases/register");
  const value = {
    release,
    deployment: {
      environment: "staging",
      review: { provider: "gitlab", repositoryId: 12, number: 34 },
    },
  };

  await expect(
    registerRelease(service, new Headers(), projectId, value),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    registerRelease(service, headers, randomUUID(), value),
  ).rejects.toMatchObject({ status: 401 });
  const registered = await registerRelease(service, headers, projectId, value);

  await registerRelease(service, headers, projectId, value);
  expect(
    await web.releaseDeployment.count({
      where: { releaseId: registered.id, reviewKey: "gitlab:12:34" },
    }),
  ).toBe(1);
  await registerRelease(service, headers, projectId, {
    release,
    deployment: { environment: "production" },
  });
  const locations = await web.releaseDeployment.findMany({
    where: { releaseId: registered.id },
  });

  expect(locations.map((item) => item.environment)).toEqual(
    expect.arrayContaining(["production", "staging"]),
  );
  const ingest = createDatabase(instance.urls.ingest);

  try {
    await expect(ingest.releaseDeployment.findMany()).rejects.toThrow();
  } finally {
    await ingest.$disconnect();
  }
});

it("rejects revoked tokens and cleans orphan files without following symlinks", async () => {
  await instance.admin.sourceMapToken.updateMany({
    where: { projectId },
    data: { revokedAt: new Date() },
  });
  await expect(
    authorizeUpload(service, headers, projectId),
  ).rejects.toMatchObject({ status: 401 });
  const orphan = randomUUID();
  const link = randomUUID();

  await store.write(orphan, Buffer.from("{}"));
  await symlink(
    join(store.root, orphan + ".map"),
    join(store.root, link + ".map"),
  );
  await expect(store.read(link)).rejects.toThrow();
  await retainSourceMaps(worker, store, new Date(Date.now() + 1000));
  expect(await store.exists(orphan)).toBe(false);
});
