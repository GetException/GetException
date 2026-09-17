import { createHash, randomUUID } from "node:crypto";
import {
  boundedJson,
  SOURCE_MAP_LIMITS,
  sourceUploadSchema,
} from "@getexception/protocol";
import { SourceMapStore } from "@getexception/source-maps";
import type { AuthService } from "../auth-service";
import { AuthError } from "../auth-error";
import { digest } from "../crypto";

export async function authorizeUpload(
  service: AuthService,
  headers: Headers,
  projectId: string,
) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(
    headers.get("authorization") ?? "",
  );

  if (!match) {
    throw new AuthError(401);
  }

  const credential = await service.db.sourceMapToken.findFirst({
    where: {
      projectId,
      tokenHash: digest(match[1]!),
      revokedAt: null,
      expiresAt: { gt: new Date() },
      project: { enabled: true, deletedAt: null },
    },
  });

  if (!credential) {
    await service.rateLimit(
      headers.get("x-real-ip") ?? "unknown",
      projectId,
      "source_map_auth",
    );

    throw new AuthError(401);
  }

  return credential;
}

export async function beginUpload(
  service: AuthService,
  headers: Headers,
  projectId: string,
  value: unknown,
  store = new SourceMapStore(),
) {
  await authorizeUpload(service, headers, projectId);
  const input = sourceUploadSchema.parse(value);
  const artifacts = input.artifacts
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifestHash = createHash("sha256")
    .update(JSON.stringify({ release: input.release, artifacts }))
    .digest("hex");

  await service.rateLimit(
    headers.get("x-real-ip") ?? "unknown",
    projectId,
    "source_map_upload",
  );

  return service.db.$transaction(
    async (tx) => {
      // Reserves global/project disk budgets across simultaneous uploads.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(73104621)`;
      const projects = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM project WHERE id = ${projectId} AND enabled AND "deletedAt" IS NULL FOR UPDATE`;

      if (!projects.length) {
        throw new AuthError(404);
      }

      const prior = await tx.sourceMapUpload.findUnique({
        where: { projectId_manifestHash: { projectId, manifestHash } },
        include: { artifacts: true },
      });

      if (prior) {
        if (prior.status === "failed") {
          throw new AuthError(409, "source_map_failed");
        }

        const missing = (
          await Promise.all(
            prior.artifacts.map(async (file) =>
              file.uploadedAt && (await store.exists(file.storageId))
                ? undefined
                : file.id,
            ),
          )
        ).filter((id): id is string => Boolean(id));

        if (missing.length) {
          await tx.sourceArtifact.updateMany({
            where: { id: { in: missing } },
            data: { uploadedAt: null },
          });
          await tx.sourceMapUpload.update({
            where: { id: prior.id },
            data: { status: "receiving", attempts: 0 },
          });
        }

        return {
          uploadId: prior.id,
          status: missing.length ? "receiving" : prior.status,
          artifacts: prior.artifacts.map(({ id, path, uploadedAt }) => ({
            id,
            path,
            uploaded: Boolean(uploadedAt) && !missing.includes(id),
          })),
        };
      }

      const existing = await tx.sourceArtifact.findMany({
        where: {
          projectId,
          debugId: { in: artifacts.map((file) => file.debugId) },
        },
        distinct: ["debugId", "sha256"],
      });
      const prepared = await Promise.all(
        artifacts.map(async (file) => {
          const matches = existing.filter(
            (item) => item.debugId === file.debugId,
          );

          if (
            matches.some(
              (item) =>
                item.sha256 !== file.sha256 ||
                item.size !== file.size ||
                item.path !== file.path,
            )
          ) {
            throw new AuthError(409, "source_map_conflict");
          }

          const prior = matches[0];

          return {
            ...file,
            projectId,
            release: input.release,
            storageId: prior?.storageId ?? randomUUID(),
            uploadedAt:
              prior?.uploadedAt && (await store.exists(prior.storageId))
                ? prior.uploadedAt
                : null,
          };
        }),
      );
      const [usage, fileCount] = await Promise.all([
        tx.$queryRaw<{ projectBytes: bigint; totalBytes: bigint }[]>`
          SELECT COALESCE(sum(size) FILTER (WHERE "projectId" = ${projectId}), 0)::bigint AS "projectBytes",
                 COALESCE(sum(size), 0)::bigint AS "totalBytes"
          FROM (SELECT "storageId", "projectId", max(size) AS size FROM source_artifact GROUP BY "storageId", "projectId") files`,
        tx.sourceArtifact.count(),
      ]);
      const bytes = prepared
        .filter(
          (file) => !existing.some((item) => item.storageId === file.storageId),
        )
        .reduce((sum, file) => sum + file.size, 0);

      if (
        Number(usage[0]?.projectBytes ?? 0) + bytes >
          SOURCE_MAP_LIMITS.projectBytes ||
        Number(usage[0]?.totalBytes ?? 0) + bytes >
          SOURCE_MAP_LIMITS.installationBytes ||
        fileCount + artifacts.length > 100_000
      ) {
        throw new AuthError(413, "source_map_quota");
      }

      const upload = await tx.sourceMapUpload.create({
        data: {
          projectId,
          release: input.release,
          manifestHash,
          artifacts: {
            create: prepared,
          },
        },
        include: { artifacts: true },
      });

      await tx.release.upsert({
        where: { projectId_name: { projectId, name: input.release } },
        create: { projectId, name: input.release, sourceMapsState: "pending" },
        update: {},
      });
      await tx.release.updateMany({
        where: { projectId, name: input.release, sourceMapsVersion: 0 },
        data: { sourceMapsState: "pending" },
      });
      await tx.auditLog.create({
        data: { id: randomUUID(), action: "source_map_upload", success: true },
      });

      return {
        uploadId: upload.id,
        status: upload.status,
        artifacts: upload.artifacts.map(({ id, path, uploadedAt }) => ({
          id,
          path,
          uploaded: Boolean(uploadedAt),
        })),
      };
    },
    { timeout: 15000 },
  );
}

export async function uploadArtifact(
  service: AuthService,
  request: Request,
  projectId: string,
  uploadId: string,
  id: string,
  store = new SourceMapStore(),
) {
  await authorizeUpload(service, request.headers, projectId);
  const file = await service.db.sourceArtifact.findFirst({
    where: { id, projectId, uploadId, upload: { status: "receiving" } },
  });

  if (!file) {
    throw new AuthError(404);
  }

  const bytes = await readUploadBody(request, file.size);

  if (
    bytes.length !== file.size ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256
  ) {
    throw new AuthError(400, "source_map_checksum");
  }

  await authorizeUpload(service, request.headers, projectId);
  await service.db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM source_map_upload WHERE id = ${uploadId} AND "projectId" = ${projectId} AND status = 'receiving' FOR UPDATE`;

      if (!rows.length) {
        throw new AuthError(409);
      }

      await store.write(file.storageId, bytes);
      await tx.sourceArtifact.update({
        where: { id: file.id },
        data: { uploadedAt: new Date() },
      });
    },
    { timeout: 15000 },
  );

  return { ok: true };
}

export async function finishUpload(
  service: AuthService,
  headers: Headers,
  projectId: string,
  id: string,
) {
  await authorizeUpload(service, headers, projectId);

  return service.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM source_map_upload WHERE id = ${id} AND "projectId" = ${projectId} FOR UPDATE`;
    const upload = await tx.sourceMapUpload.findFirst({
      where: { id, projectId },
      include: { artifacts: { select: { uploadedAt: true } } },
    });

    if (!upload) {
      throw new AuthError(404);
    }

    if (upload.artifacts.some((file) => !file.uploadedAt)) {
      throw new AuthError(409, "source_map_incomplete");
    }

    if (upload.status === "failed") {
      throw new AuthError(409, "source_map_failed");
    }

    if (upload.status === "receiving") {
      await tx.sourceMapUpload.update({
        where: { id },
        data: { status: "pending" },
      });
    }

    return {
      status: upload.status === "receiving" ? "pending" : upload.status,
    };
  });
}

export async function uploadStatus(
  service: AuthService,
  headers: Headers,
  projectId: string,
  id: string,
) {
  await authorizeUpload(service, headers, projectId);
  const upload = await service.db.sourceMapUpload.findFirst({
    where: { id, projectId },
    select: { status: true, errorCode: true },
  });

  if (!upload) {
    throw new AuthError(404);
  }

  return upload;
}

export function checkUploadRequest(request: Request) {
  if (
    (new URL(request.url).protocol !== "https:" &&
      request.headers.get("x-forwarded-proto") !== "https") ||
    request.headers.has("origin")
  ) {
    throw new AuthError(403);
  }
}

export async function readUploadBody(request: Request, max: number) {
  if (
    request.headers.get("content-type")?.split(";")[0] !== "application/json" ||
    ![null, "identity"].includes(request.headers.get("content-encoding"))
  ) {
    throw new AuthError(415);
  }

  if (Number(request.headers.get("content-length") ?? 0) > max) {
    throw new AuthError(413);
  }

  const reader = request.body?.getReader();

  if (!reader) {
    throw new AuthError(400);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.length;

    if (size > max) {
      await reader.cancel();

      throw new AuthError(413);
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks, size);
}

export async function readUploadManifest(request: Request) {
  return boundedJson(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await readUploadBody(request, SOURCE_MAP_LIMITS.manifestBytes),
    ),
    SOURCE_MAP_LIMITS.manifestBytes,
  );
}
