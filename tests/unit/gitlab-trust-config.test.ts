import { expect, it, vi } from "vitest";
import { createGitlabTrust } from "../../scripts/gitlab-trust-config";
import { ciProject, ciRepository, gitlabFixture } from "../helpers/gitlab-ci";

const fixture = gitlabFixture();
const options = {
  gitlab: "https://gitlab.example.test",
  projectId: ciProject,
  repositoryId: 123,
  repositoryPath: ciRepository,
  releasePrefix: "account",
};

it("pins the literal HTTP issuer behind a TLS proxy while fetching only over HTTPS", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        issuer: "http://gitlab.example.test",
        jwks_uri: "http://gitlab.example.test/oauth/discovery/keys",
      }),
    )
    .mockResolvedValueOnce(Response.json(fixture.policy.jwks));
  const policy = await createGitlabTrust(options, transport);

  expect(policy.issuer).toBe("http://gitlab.example.test");
  expect(policy.projects[0]?.repositoryId).toBe(123);
  expect(policy.jwks).toEqual(fixture.policy.jwks);
  expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
    "https://gitlab.example.test/.well-known/openid-configuration",
    "https://gitlab.example.test/oauth/discovery/keys",
  ]);

  for (const [, init] of transport.mock.calls) {
    expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
  }
});

it.each([
  { issuer: "https://other.test" },
  { issuer: "https://gitlab.example.test/path" },
  { jwks_uri: "https://other.test/keys" },
  { jwks_uri: "https://user:password@gitlab.example.test/keys" },
  { jwks_uri: "https://gitlab.example.test/keys?token=secret" },
  { jwks_uri: "ftp://gitlab.example.test/keys" },
])(
  "rejects discovery redirects to untrusted identifiers before fetching keys: %j",
  async (changes) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        issuer: options.gitlab,
        jwks_uri: `${options.gitlab}/oauth/discovery/keys`,
        ...changes,
      }),
    );

    await expect(createGitlabTrust(options, transport)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  },
);

it("refuses HTTP configuration, redirects and oversized metadata including chunked responses", async () => {
  const transport = vi.fn<typeof fetch>();

  await expect(
    createGitlabTrust(
      { ...options, gitlab: "http://gitlab.example.test" },
      transport,
    ),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();

  for (const response of [
    new Response(null, {
      status: 302,
      headers: { location: "http://gitlab.example.test/keys" },
    }),
    new Response("{}", { headers: { "content-length": "65537" } }),
    new Response("x".repeat(65537)),
  ]) {
    transport.mockResolvedValueOnce(response);
    await expect(createGitlabTrust(options, transport)).rejects.toThrow();
  }
});
