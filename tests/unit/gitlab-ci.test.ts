import { afterEach, expect, it, vi } from "vitest";
import { parseGitlabTrust } from "@getexception/config";
import { authorizeGitlab } from "../../apps/web/src/server/source-maps/gitlab";
import {
  assertReleaseScope,
  assertUploadScope,
} from "../../apps/web/src/server/source-maps/authorization";
import type { AuthService } from "../../apps/web/src/server/auth-service";
import {
  gitlabFixture,
  ciProject,
  ciSha,
  ciAudience,
  ciRepository,
} from "../helpers/gitlab-ci";
import {
  authorizationHeader,
  ciCredential,
} from "../../packages/cli/src/credentials";
import { buildContext } from "../../packages/cli/src/ci";

const fixture = gitlabFixture();
const activeProject = vi.fn().mockResolvedValue({ id: ciProject });
const service = {
  config: {
    GITLAB_CI_TRUST: JSON.stringify(fixture.policy),
    DASHBOARD_ORIGIN: ciAudience,
  },
  db: { project: { findFirst: activeProject } },
} as unknown as AuthService;

afterEach(() => {
  vi.unstubAllGlobals();
  activeProject.mockResolvedValue({ id: ciProject });
});

it("verifies a real GitLab signature locally and binds its exact build without network access", async () => {
  const network = vi.fn(() => {
    throw new Error("Unexpected network request");
  });

  vi.stubGlobal("fetch", network);
  expect(
    await authorizeGitlab(service, await fixture.sign(), ciProject),
  ).toEqual({
    release: `account@${ciSha}`,
    assetPrefix: "assets/ge-gl-123-456/",
    deployment: {
      environment: "staging",
      review: { provider: "gitlab", repositoryId: 123, number: 554 },
    },
  });
  expect(network).not.toHaveBeenCalled();
});

it.each([
  { iss: "https://attacker.example.test" },
  { aud: "https://other.example.test" },
  { aud: [ciAudience, "https://other.example.test"] },
  { exp: 1 },
  { iat: 1 },
  { nbf: 9999999999 },
  { exp: 9999999999 },
  { exp: undefined },
  { iat: undefined },
  { jti: undefined },
  { nbf: undefined },
  { project_id: "999" },
  { project_path: "attacker/account" },
  { job_project_id: "999" },
  { job_project_path: "attacker/account" },
  { sha: "b".repeat(40) },
  { ci_config_sha: "b".repeat(40) },
  {
    ci_config_ref_uri: `evil.test/${ciRepository}//.gitlab-ci.yml@refs/heads/feature`,
  },
  { ci_config_ref_uri: null },
  { ref_path: "refs/heads/stable" },
  { environment: "production/app" },
  { environment: "unknown" },
  { environment: "review/" },
  { pipeline_source: "parent_pipeline" },
  { pipeline_source: "external_pull_request_event" },
  { job_id: "../456" },
  { job_id: 0 },
  { sha: "HEAD" },
])("rejects mismatched, expired and untrusted claims: %j", async (claims) => {
  await expect(
    authorizeGitlab(service, await fixture.sign(claims), ciProject),
  ).rejects.toMatchObject({ status: 401 });
});

it("rejects forged signatures, remote key pointers, unknown keys and inactive projects", async () => {
  const other = gitlabFixture();

  for (const jwt of [
    await other.sign(),
    await fixture.sign({}, { kid: "missing" }),
    await fixture.sign({}, { jku: "https://attacker.test/jwks" }),
    await fixture.sign({}, { jwk: other.policy.jwks.keys[0] }),
    "a".repeat(20000),
    "not.a.jwt",
  ]) {
    await expect(
      authorizeGitlab(service, jwt, ciProject),
    ).rejects.toMatchObject({ status: 401 });
  }

  await expect(
    authorizeGitlab(service, await fixture.sign(), "unknown"),
  ).rejects.toMatchObject({ status: 401 });
  activeProject.mockResolvedValue(null);
  await expect(
    authorizeGitlab(service, await fixture.sign(), ciProject),
  ).rejects.toMatchObject({ status: 401 });
});

it("requires explicit protected production refs and never promotes an MR", async () => {
  const production = {
    pipeline_source: "push",
    environment: "production/app",
    ref: "stable",
    ref_path: "refs/heads/stable",
    ref_protected: "true",
    ci_config_ref_uri: `gitlab.example.test/${ciRepository}//.gitlab-ci.yml@refs/heads/stable`,
  };

  expect(
    (await authorizeGitlab(service, await fixture.sign(production), ciProject))
      .deployment,
  ).toEqual({ environment: "production" });

  for (const changes of [
    { ref_protected: "false" },
    { pipeline_source: "merge_request_event" },
    {
      ref: "other",
      ref_path: "refs/heads/other",
      ci_config_ref_uri: `gitlab.example.test/${ciRepository}//.gitlab-ci.yml@refs/heads/other`,
    },
  ]) {
    await expect(
      authorizeGitlab(
        service,
        await fixture.sign({ ...production, ...changes }),
        ciProject,
      ),
    ).rejects.toMatchObject({ status: 401 });
  }
});

it("isolates jobs sharing a SHA and prevents release/environment/review substitutions", async () => {
  const context = await authorizeGitlab(
    service,
    await fixture.sign(),
    ciProject,
  );
  const principal = { kind: "gitlab" as const, context };

  expect(() =>
    assertUploadScope(principal, context.release, [
      { path: context.assetPrefix + "app.js" },
    ]),
  ).not.toThrow();

  for (const path of [
    "assets/app.js",
    "assets/ge-gl-123-4567/app.js",
    "assets/ge-gl-123-999/app.js",
  ]) {
    expect(() =>
      assertUploadScope(principal, context.release, [{ path }]),
    ).toThrow();
  }

  expect(() =>
    assertUploadScope(principal, `account@${"b".repeat(40)}`, [
      { path: context.assetPrefix + "app.js" },
    ]),
  ).toThrow();
  expect(() =>
    assertReleaseScope(principal, context.release, context.deployment),
  ).not.toThrow();
  expect(() =>
    assertReleaseScope(principal, context.release, {
      environment: "production",
    }),
  ).toThrow();
  expect(() =>
    assertReleaseScope(principal, context.release, {
      environment: "staging",
      review: { provider: "gitlab", repositoryId: 999, number: 554 },
    }),
  ).toThrow();
});

it("validates pinned public keys and does not accept private keys or ambiguous policies", () => {
  expect(parseGitlabTrust(JSON.stringify(fixture.policy))).toBeDefined();

  for (const policy of [
    {
      ...fixture.policy,
      jwks: { keys: [{ ...fixture.policy.jwks.keys[0], d: "PRIVATE" }] },
    },
    {
      ...fixture.policy,
      projects: [...fixture.policy.projects, ...fixture.policy.projects],
    },
    {
      ...fixture.policy,
      jwks: {
        keys: [...fixture.policy.jwks.keys, ...fixture.policy.jwks.keys],
      },
    },
  ]) {
    expect(() => parseGitlabTrust(JSON.stringify(policy))).toThrow();
  }
});

it("accepts older GitLab claims and literal proxy issuers, and revokes trust without network fallback", async () => {
  const localService = {
    ...service,
    config: {
      ...service.config,
      GITLAB_CI_TRUST: JSON.stringify({
        ...fixture.policy,
        issuer: "http://gitlab.example.test",
      }),
    },
  } as AuthService;
  const jwt = await fixture.sign({
    iss: "http://gitlab.example.test",
    job_project_id: undefined,
    job_project_path: undefined,
  });

  expect((await authorizeGitlab(localService, jwt, ciProject)).release).toBe(
    `account@${ciSha}`,
  );
  localService.config.GITLAB_CI_TRUST = JSON.stringify({
    ...fixture.policy,
    issuer: "http://gitlab.example.test",
    jwks: gitlabFixture().policy.jwks,
  });
  await expect(
    authorizeGitlab(localService, jwt, ciProject),
  ).rejects.toMatchObject({ status: 401 });
  localService.config.GITLAB_CI_TRUST = "";
  await expect(
    authorizeGitlab(localService, jwt, ciProject),
  ).rejects.toMatchObject({ status: 401 });
});

it("keeps CLI identity in the authorization header, requires HTTPS and rejects mixed credentials", async () => {
  const jwt = await fixture.sign();
  const context = await authorizeGitlab(service, jwt, ciProject);
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(context));

  expect(ciCredential({ GETEXCEPTION_GITLAB_ID_TOKEN: jwt })).toEqual({
    gitlabIdToken: jwt,
  });
  expect(() =>
    ciCredential({
      GETEXCEPTION_GITLAB_ID_TOKEN: jwt,
      GETEXCEPTION_UPLOAD_TOKEN: "a".repeat(64),
    }),
  ).toThrow();
  expect(() =>
    authorizationHeader({ gitlabIdToken: "invalid\r\nheader" }),
  ).toThrow();
  expect(
    await buildContext(
      ciAudience,
      ciProject,
      { gitlabIdToken: jwt },
      transport,
    ),
  ).toEqual(context);
  expect(transport).toHaveBeenCalledWith(
    `${ciAudience}/api/v1/projects/${ciProject}/ci`,
    expect.objectContaining({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: {
        Authorization: `GitLab ${jwt}`,
        "Content-Type": "application/json",
      },
    }),
  );
  await expect(
    buildContext(
      "http://monitor.example.test",
      ciProject,
      { gitlabIdToken: jwt },
      transport,
    ),
  ).rejects.toThrow();
});
