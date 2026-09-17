import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDatabase } from "@getexception/db";
import { SourceMapStore } from "@getexception/source-maps";
import { sanitizeEvent } from "@getexception/protocol";
import { temporaryDatabase } from "./database";
import {
  gitlabFixture,
  ciAudience,
  ciSha,
  ciRepository,
} from "../helpers/gitlab-ci";
import { createRuntime } from "../../apps/web/src/server/runtime";
import { token } from "../../apps/web/src/server/crypto";
import { authorizeGitlab } from "../../apps/web/src/server/source-maps/gitlab";
import {
  beginUpload,
  uploadArtifact,
  finishUpload,
  uploadStatus,
} from "../../apps/web/src/server/source-maps/upload";
import { registerRelease } from "../../apps/web/src/server/releases/register";
import { prepareMaps, readPreparedMap } from "../../packages/cli/src/prepare";
import { uploadMaps } from "../../packages/cli/src/upload";
import { validateOneUpload } from "../../apps/worker/src/source-maps/uploads";
import { resolveFrames } from "../../apps/worker/src/source-maps/resolve";

let instance: Awaited<ReturnType<typeof temporaryDatabase>>;
let web: ReturnType<typeof createDatabase>;
let worker: ReturnType<typeof createDatabase>;
let service: ReturnType<typeof createRuntime>["service"];
let store: SourceMapStore;
let projectId: string;
let fixture: ReturnType<typeof gitlabFixture>;
let jwt: string;
let headers: Headers;
let receipt: Awaited<ReturnType<typeof beginUpload>>;
let manifest: Awaited<ReturnType<typeof prepareMaps>>;
let privateDir: string;

beforeAll(async () => {
  instance = await temporaryDatabase();
  web = createDatabase(instance.urls.web);
  worker = createDatabase(instance.urls.worker);
  store = new SourceMapStore(join(instance.directory, "maps"));
  const organization = await instance.admin.organization.create({
    data: { id: randomUUID(), name: "CI", slug: "ci" },
  });
  const project = await instance.admin.project.create({
    data: { organizationId: organization.id, name: "Account", slug: "account" },
  });

  projectId = project.id;
  fixture = gitlabFixture(projectId);
  service = createRuntime(
    {
      DATABASE_URL: instance.urls.web,
      DASHBOARD_ORIGIN: ciAudience,
      INGEST_ORIGIN: "https://ingest.example.test",
      BETTER_AUTH_SECRET: token(),
      TOTP_ENCRYPTION_KEY: token(),
      AUTH_RATE_KEY: token(),
      MAIL_ENCRYPTION_KEY: token(),
      MAIL_ENABLED: false,
      GITLAB_CI_TRUST: JSON.stringify(fixture.policy),
    },
    web,
  ).service;
  jwt = await fixture.sign();
  headers = new Headers({
    authorization: `GitLab ${jwt}`,
    "x-real-ip": "test",
  });
});

afterAll(async () => {
  await Promise.all([web?.$disconnect(), worker?.$disconnect()]);
  await instance?.cleanup();
});

it("prepares, uploads and resolves a real MR map using only its signed identity", async () => {
  const context = await authorizeGitlab(service, jwt, projectId);
  const dist = join(instance.directory, "dist");

  privateDir = join(instance.directory, "private");
  await mkdir(join(dist, context.assetPrefix), { recursive: true });
  await writeFile(
    join(dist, context.assetPrefix, "app.js"),
    'throw new Error("ci test");',
  );
  await writeFile(
    join(dist, context.assetPrefix, "app.js.map"),
    JSON.stringify({
      version: 3,
      sources: ["src/checkout.tsx"],
      names: ["checkout"],
      mappings: "AAAAA",
      sourcesContent: ['throw new Error("ci test");'],
    }),
  );
  manifest = await prepareMaps(dist, privateDir, context.release);
  const transport: typeof fetch = async (address, init) => {
    const request = new Request(String(address), init);
    const parts = new URL(request.url).pathname
      .split("/source-maps")[1]!
      .split("/")
      .filter(Boolean);
    let response: unknown;

    if (!parts.length) {
      receipt = await beginUpload(
        service,
        request.headers,
        projectId,
        await request.json(),
        store,
      );
      response = receipt;
    } else if (parts.length === 2) {
      response = await uploadArtifact(
        service,
        request,
        projectId,
        parts[0]!,
        parts[1]!,
        store,
      );
    } else if (request.method === "POST") {
      response = await finishUpload(
        service,
        request.headers,
        projectId,
        parts[0]!,
      );
      await validateOneUpload(worker, store);
    } else {
      response = await uploadStatus(
        service,
        request.headers,
        projectId,
        parts[0]!,
      );
    }

    return Response.json(response);
  };

  await uploadMaps(
    privateDir,
    ciAudience,
    projectId,
    { gitlabIdToken: jwt },
    transport,
  );
  expect(
    await uploadStatus(service, headers, projectId, receipt.uploadId),
  ).toEqual({ status: "ready", errorCode: null });
  await registerRelease(service, headers, projectId, {
    release: context.release,
    deployment: context.deployment,
  });
  const event = sanitizeEvent(
    {
      release: context.release,
      exception: {
        values: [
          {
            type: "Error",
            value: "ci test",
            stacktrace: {
              frames: [
                {
                  filename: `https://preview.example.test/${manifest.artifacts[0]!.path}`,
                  lineno: 2,
                  colno: 1,
                  debug_id: manifest.artifacts[0]!.debugId,
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
    },
    randomUUID().replaceAll("-", ""),
  );
  const resolved = await resolveFrames(worker, projectId, event, store);

  expect(resolved.state).toBe("complete");
  expect(resolved.originalFrames[0]).toMatchObject({
    filename: "src/checkout.tsx",
    lineno: 1,
    function: "checkout",
  });
  expect(
    (
      await resolveFrames(
        worker,
        projectId,
        {
          ...event,
          frames: event.frames.map((frame) => ({
            ...frame,
            filename: "/assets/ge-gl-123-999/app.js",
          })),
        },
        store,
      )
    ).state,
  ).toBe("missing");
});

it("rejects every cross-build operation even with a valid same-project same-SHA token", async () => {
  const other = new Headers({
    authorization: `GitLab ${await fixture.sign({ job_id: "999" })}`,
  });

  await expect(
    beginUpload(service, other, projectId, manifest, store),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    uploadStatus(service, other, projectId, receipt.uploadId),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    finishUpload(service, other, projectId, receipt.uploadId),
  ).rejects.toMatchObject({ status: 403 });
  const pending = await beginUpload(
    service,
    headers,
    projectId,
    {
      ...manifest,
      artifacts: [
        {
          ...manifest.artifacts[0],
          path: "assets/ge-gl-123-456/other.js",
          debugId: randomUUID(),
        },
      ],
    },
    store,
  );
  const bytes = await readPreparedMap(privateDir, manifest.artifacts[0]!);

  await expect(
    uploadArtifact(
      service,
      new Request(ciAudience, {
        method: "PUT",
        headers: {
          ...Object.fromEntries(other),
          "Content-Type": "application/json",
        },
        body: new Uint8Array(bytes),
      }),
      projectId,
      pending.uploadId,
      pending.artifacts[0]!.id,
      store,
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    await worker.sourceMapUpload.findUnique({
      where: { id: receipt.uploadId },
    }),
  ).toMatchObject({ status: "ready" });
});

it("does not let an MR write production, another release or another project", async () => {
  await expect(
    registerRelease(service, headers, projectId, {
      release: `account@${ciSha}`,
      deployment: { environment: "production" },
    }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    beginUpload(
      service,
      headers,
      projectId,
      { ...manifest, release: `account@${"b".repeat(40)}` },
      store,
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    beginUpload(service, headers, randomUUID(), manifest, store),
  ).rejects.toMatchObject({ status: 401 });
  const deployments = await worker.releaseDeployment.findMany();

  expect(deployments.map((item) => item.environment)).toEqual(["staging"]);
});

it("keeps production and preview artifacts separate even when an MR copies a known Debug ID", async () => {
  const prod = new Headers({
    authorization: `GitLab ${await fixture.sign({
      job_id: "888",
      pipeline_source: "push",
      environment: "production/app",
      ref: "stable",
      ref_path: "refs/heads/stable",
      ref_protected: "true",
      ci_config_ref_uri: `gitlab.example.test/${ciRepository}//.gitlab-ci.yml@refs/heads/stable`,
    })}`,
  });
  const result = await beginUpload(
    service,
    prod,
    projectId,
    {
      ...manifest,
      artifacts: [
        { ...manifest.artifacts[0], path: "assets/ge-gl-123-888/app.js" },
      ],
    },
    store,
  );

  expect(result.artifacts[0]?.uploaded).toBe(false);
  const original = await worker.sourceArtifact.findUniqueOrThrow({
    where: { id: receipt.artifacts[0]!.id },
  });
  const production = await worker.sourceArtifact.findUniqueOrThrow({
    where: { id: result.artifacts[0]!.id },
  });

  expect(production.storageId).not.toBe(original.storageId);
  await expect(
    uploadStatus(service, headers, projectId, result.uploadId),
  ).rejects.toMatchObject({ status: 403 });
});

it("rejects an expired identity and immediately disabled trust without changing stored data", async () => {
  const expired = new Headers({
    authorization: `GitLab ${await fixture.sign({ exp: 1 })}`,
  });

  await expect(
    uploadStatus(service, expired, projectId, receipt.uploadId),
  ).rejects.toMatchObject({ status: 401 });
  const trust = service.config.GITLAB_CI_TRUST;

  service.config.GITLAB_CI_TRUST = "";
  await expect(
    uploadStatus(service, headers, projectId, receipt.uploadId),
  ).rejects.toMatchObject({ status: 401 });
  service.config.GITLAB_CI_TRUST = trust;
  expect(
    await uploadStatus(service, headers, projectId, receipt.uploadId),
  ).toMatchObject({ status: "ready" });
});
