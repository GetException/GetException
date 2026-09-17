import { gitlabTrustSchema } from "@getexception/config";
import { z } from "zod";

async function readPublicJson(url: URL, transport: typeof fetch) {
  const response = await transport(url, {
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(15000),
    headers: { Accept: "application/json" },
  });

  if (
    !response.ok ||
    Number(response.headers.get("content-length")) > 65536 ||
    !response.body
  ) {
    await response.body?.cancel();

    throw new Error("Public GitLab metadata is unavailable");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    size += value.length;

    if (size > 65536) {
      await reader.cancel();

      throw new Error("Public GitLab metadata is too large");
    }

    chunks.push(value);
  }

  return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
}

export async function createGitlabTrust(
  options: {
    gitlab: string;
    projectId: string;
    repositoryId: number;
    repositoryPath: string;
    releasePrefix: string;
    productionEnvironment?: string;
    productionRefs?: string[];
  },
  transport: typeof fetch = fetch,
) {
  const origin = new URL(options.gitlab ?? "");

  if (origin.protocol !== "https:" || origin.origin !== options.gitlab) {
    throw new Error("Use an HTTPS GitLab origin and matching public metadata");
  }

  const metadata = z
    .object({ issuer: z.string().url(), jwks_uri: z.string().url() })
    .parse(
      await readPublicJson(
        new URL("/.well-known/openid-configuration", origin),
        transport,
      ),
    );
  const keysUrl = new URL(metadata.jwks_uri);
  const issuerUrl = new URL(metadata.issuer);

  if (
    !["http:", "https:"].includes(keysUrl.protocol) ||
    !["http:", "https:"].includes(issuerUrl.protocol)
  ) {
    throw new Error("GitLab discovery must use HTTP identifiers or HTTPS");
  }

  // Some self-hosted installations advertise HTTP behind a TLS proxy.
  // The identifier is pinned literally; network transport always remains HTTPS.
  keysUrl.protocol = "https:";
  issuerUrl.protocol = "https:";

  if (
    keysUrl.origin !== origin.origin ||
    issuerUrl.origin !== origin.origin ||
    keysUrl.username ||
    keysUrl.password ||
    keysUrl.hash ||
    keysUrl.search ||
    issuerUrl.username ||
    issuerUrl.password ||
    issuerUrl.pathname !== "/" ||
    issuerUrl.search ||
    issuerUrl.hash
  ) {
    throw new Error("GitLab discovery must stay on the configured host");
  }

  const policy = gitlabTrustSchema.parse({
    issuer: metadata.issuer,
    jwks: await readPublicJson(keysUrl, transport),
    projects: [
      {
        projectId: options.projectId,
        repositoryId: options.repositoryId,
        repositoryPath: options.repositoryPath,
        releasePrefix: options.releasePrefix,
        productionEnvironment: options.productionEnvironment,
        productionRefs: options.productionRefs ?? [],
      },
    ],
  });

  return policy;
}
