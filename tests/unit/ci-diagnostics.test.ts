import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { buildContext } from "../../packages/cli/src/ci";
import { projectApi } from "../../packages/cli/src/api";
import { httpError, responseJson } from "../../packages/cli/src/api-response";
import {
  CliError,
  formatDiagnostic,
  networkError,
} from "../../packages/cli/src/diagnostics";
import { safeRoute } from "../../apps/web/src/server/http";
import { CiAuthError } from "../../apps/web/src/server/source-maps/ci-error";
import {
  authorizeCiContext,
  authorizeUpload,
} from "../../apps/web/src/server/source-maps/authorization";
import type { AuthService } from "../../apps/web/src/server/auth-service";
import { AuthError } from "../../apps/web/src/server/auth-error";
import { gitlabFixture, ciAudience, ciProject } from "../helpers/gitlab-ci";

const fixture = gitlabFixture();
const canary = "PRIVATE_TEST_VALUE_MUST_NOT_BE_LOGGED";

function service() {
  const rateLimit = vi.fn().mockResolvedValue(undefined);
  const findFirst = vi.fn().mockResolvedValue({ id: ciProject });

  return {
    rateLimit,
    findFirst,
    auth: {
      config: {
        GITLAB_CI_TRUST: JSON.stringify(fixture.policy),
        DASHBOARD_ORIGIN: ciAudience,
      },
      db: { project: { findFirst } },
      rateLimit,
    } as unknown as AuthService,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  ["ENOTFOUND", "NETWORK_DNS"],
  ["EAI_AGAIN", "NETWORK_DNS"],
  ["CERT_HAS_EXPIRED", "NETWORK_TLS"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "NETWORK_TLS"],
  ["ECONNREFUSED", "NETWORK_CONNECTION"],
  ["ECONNRESET", "NETWORK_CONNECTION"],
  ["ETIMEDOUT", "NETWORK_TIMEOUT"],
  ["UND_ERR_CONNECT_TIMEOUT", "NETWORK_TIMEOUT"],
  [canary, "NETWORK_ERROR"],
])(
  "classifies network code %s without printing native errors",
  async (code, expected) => {
    vi.useFakeTimers();
    const error = new TypeError(canary, {
      cause: Object.assign(new Error(canary), { code }),
    });
    const transport = vi.fn<typeof fetch>().mockRejectedValue(error);
    const request = projectApi(
      ciAudience,
      ciProject,
      "a".repeat(64),
      transport,
    );
    const pending = request("/ci?version=2", "POST");
    const assertion = expect(pending).rejects.toMatchObject({
      code: expected,
    });

    await vi.runAllTimersAsync();
    await assertion;
    expect(transport).toHaveBeenCalledTimes(expected === "NETWORK_TLS" ? 1 : 3);
    expect(formatDiagnostic(networkError(error))).toBe(
      `GETEXCEPTION_DIAGNOSTIC ${JSON.stringify({ version: 1, code: expected })}\n`,
    );
  },
);

it("keeps timeout, malformed JSON and contract errors distinct", async () => {
  expect(networkError(new DOMException(canary, "TimeoutError")).code).toBe(
    "NETWORK_TIMEOUT",
  );
  await expect(responseJson(new Response(canary))).rejects.toMatchObject({
    code: "CONTRACT_JSON",
    httpStatus: 200,
  });
  await expect(
    buildContext(
      ciAudience,
      ciProject,
      { gitlabIdToken: await fixture.sign() },
      async () => Response.json({ version: 999, body: canary }),
    ),
  ).rejects.toMatchObject({ code: "CONTRACT_RESPONSE", httpStatus: 200 });
});

it("bounds response bodies and preserves an HTTP failure even for an unsafe body", async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(128 * 1024 + 1));
      },
      cancel,
    }),
  );

  await expect(responseJson(response)).rejects.toMatchObject({
    code: "CONTRACT_RESPONSE",
  });
  expect(cancel).toHaveBeenCalledOnce();

  for (const value of [
    { code: canary, requestId: randomUUID() },
    { code: "CI_IDENTITY_SIGNATURE", requestId: canary },
    { error: canary },
    canary,
  ]) {
    const error = await httpError(Response.json(value, { status: 403 }));

    expect(formatDiagnostic(error)).toBe(
      'GETEXCEPTION_DIAGNOSTIC {"version":1,"code":"HTTP_ERROR","httpStatus":403}\n',
    );
  }
});

it.each([401, 403, 429, 503])(
  "reports HTTP %s without turning a failure into a policy skip",
  async (status) => {
    vi.useFakeTimers();
    const requestId = randomUUID();
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json(
          { code: "CI_IDENTITY_CONFIG", requestId, error: canary },
          { status },
        ),
      );
    const pending = buildContext(
      ciAudience,
      ciProject,
      "a".repeat(64),
      transport,
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: "CI_IDENTITY_CONFIG",
      httpStatus: status,
      requestId,
    });

    await vi.runAllTimersAsync();
    await assertion;
    expect(transport).toHaveBeenCalledTimes(status >= 429 ? 3 : 1);
  },
);

it.each([
  [{ iss: "https://wrong.example.test" }, "CI_IDENTITY_ISSUER"],
  [{ aud: "https://wrong.example.test" }, "CI_IDENTITY_AUDIENCE"],
  [{ exp: 1 }, "CI_IDENTITY_EXPIRED"],
  [{ nbf: 9999999999 }, "CI_IDENTITY_TIME"],
  [{ job_id: canary }, "CI_IDENTITY_CLAIMS"],
  [{ project_id: "999" }, "CI_IDENTITY_SOURCE"],
  [{ job_project_id: "999" }, "CI_IDENTITY_EXECUTION"],
  [{ ref_path: "refs/heads/other" }, "CI_IDENTITY_REF"],
  [{ ci_config_sha: "b".repeat(40) }, "CI_IDENTITY_CONFIG"],
  [{ environment: canary }, "CI_IDENTITY_ENVIRONMENT"],
  [{ environment: `review/pr-${"9".repeat(80)}` }, "CI_IDENTITY_ENVIRONMENT"],
  [{ environment: "production/app" }, "CI_IDENTITY_PRODUCTION"],
])(
  "correlates CI identity failures with a safe server log: %j",
  async (claims, code) => {
    const { auth, rateLimit } = service();
    const jwt = await fixture.sign({ ...claims, private_value: canary });
    const headers = new Headers({
      authorization: `GitLab ${jwt}`,
      "x-request-id": canary,
    });
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await safeRoute(async () => {
      await authorizeCiContext(auth, headers, ciProject);

      return Response.json({});
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(rateLimit).toHaveBeenCalledOnce();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      error: "CI request failed",
      code,
      requestId: expect.any(String),
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: "ci_request_failed",
        code,
        requestId: body.requestId,
        httpStatus: 401,
      }),
    );
    expect(
      formatDiagnostic(await httpError(Response.json(body, { status: 401 }))),
    ).toBe(
      `GETEXCEPTION_DIAGNOSTIC ${JSON.stringify({ version: 1, code, httpStatus: 401, requestId: body.requestId })}\n`,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(log.mock.calls)).not.toContain(jwt);
  },
);

it("distinguishes key/signature/header failures without exposing keys", async () => {
  const { auth } = service();
  const other = gitlabFixture();

  for (const [jwt, code] of [
    [await other.sign(), "CI_IDENTITY_SIGNATURE"],
    [await fixture.sign({}, { kid: canary }), "CI_IDENTITY_KEY"],
    [await fixture.sign({}, { jku: canary }), "CI_IDENTITY_HEADER"],
  ]) {
    await expect(
      authorizeCiContext(
        auth,
        new Headers({ authorization: `GitLab ${jwt}` }),
        ciProject,
      ),
    ).rejects.toMatchObject({ status: 401, code });
  }
});

it("preserves policy denial, authentication rate limits and service failures separately", async () => {
  const { auth, rateLimit, findFirst } = service();
  const headers = new Headers({
    authorization: `GitLab ${await fixture.sign()}`,
  });

  await expect(
    authorizeCiContext(auth, headers, ciProject),
  ).resolves.toMatchObject({
    sourceMaps: { enabled: false, reason: "preview_disabled" },
  });
  await expect(authorizeUpload(auth, headers, ciProject)).rejects.toMatchObject(
    {
      status: 403,
      code: "CI_POLICY_DENIED",
    },
  );
  expect(rateLimit).not.toHaveBeenCalled();
  findFirst.mockRejectedValueOnce(new Error(canary));
  await expect(
    authorizeCiContext(auth, headers, ciProject),
  ).rejects.toMatchObject({
    status: 503,
    code: "CI_SERVER_ERROR",
  });
  expect(rateLimit).not.toHaveBeenCalled();
  rateLimit.mockRejectedValueOnce(new AuthError(429));
  await expect(
    authorizeCiContext(auth, new Headers(), ciProject),
  ).rejects.toMatchObject({
    status: 429,
    code: "CI_RATE_LIMITED",
  });
  await expect(
    authorizeCiContext(auth, new Headers(), ciProject),
  ).rejects.toMatchObject({
    status: 401,
    code: "CI_TOKEN_MISSING",
  });
});

it("prints only allowlisted diagnostics and keeps CLI failures nonzero", () => {
  expect(formatDiagnostic(new Error(canary))).not.toContain(canary);
  expect(formatDiagnostic(new CliError("HTTP_ERROR", 401, canary))).toBe(
    'GETEXCEPTION_DIAGNOSTIC {"version":1,"code":"COMMAND_FAILED"}\n',
  );
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "packages/cli/src/index.ts",
      "ci",
      "context",
      "--url",
      ciAudience,
      "--project",
      ciProject,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        GETEXCEPTION_GITLAB_ID_TOKEN: canary,
        GETEXCEPTION_UPLOAD_TOKEN: "",
      },
    },
  );

  expect(child.status).toBe(1);
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe(
    'GETEXCEPTION_DIAGNOSTIC {"version":1,"code":"CI_TOKEN_INVALID"}\n',
  );
  expect(new CiAuthError("CI_SERVER_ERROR", 503).message).not.toContain(canary);
});
