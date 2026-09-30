import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deployWithGetException,
  validateGitLabContext,
} from "../../packages/cli/src/gitlab-deployment";
import { prepareBuild } from "../../packages/cli/src/prepare-build";
import { assertPublicOutput } from "../../packages/cli/src/public-output";
import { readPrepared } from "../../packages/cli/src/prepare";

const directories: string[] = [];
const sha = "a".repeat(40);
const projectId = randomUUID();
const identity = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";
const repository = { id: 7, path: "company/frontend/account" };

function gitlabEnv(
  overrides: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    GITLAB_CI: "true",
    CI_JOB_ID: "456",
    CI_COMMIT_SHA: sha,
    CI_PROJECT_ID: "7",
    CI_PROJECT_PATH: repository.path,
    CI_PIPELINE_SOURCE: "push",
    CI_ENVIRONMENT_NAME: "production/app",
    CI_COMMIT_REF_PROTECTED: "true",
    GETEXCEPTION_GITLAB_ID_TOKEN: identity,
    ...overrides,
  };
}

function context(
  sourceMaps:
    { enabled: true } | { enabled: false; reason: "preview_disabled" } = {
    enabled: true,
  },
) {
  return {
    version: 2 as const,
    sourceMaps,
    release: `account@${sha}`,
    assetPrefix: "assets/ge-gl-7-456/",
    deployment: { environment: "production" as const },
  };
}

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "getexception-integration-"));

  directories.push(root);

  return root;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("validates a signed build context against the job and rejects a mismatched project", () => {
  const options = {
    releasePrefix: "account",
    repository,
    environment: "production" as const,
    environmentName: "production/app",
  };

  expect(validateGitLabContext(context(), gitlabEnv(), options)).toEqual(
    context(),
  );
  expect(() =>
    validateGitLabContext(
      context(),
      gitlabEnv({ CI_PROJECT_ID: "8" }),
      options,
    ),
  ).toThrow();
  expect(() =>
    validateGitLabContext(
      { ...context(), release: `other@${sha}` },
      gitlabEnv(),
      options,
    ),
  ).toThrow();
  expect(
    validateGitLabContext(
      {
        ...context(),
        release: `billing@${sha}`,
        assetPrefix: "assets/ge-gl-99-456/",
      },
      gitlabEnv({ CI_PROJECT_ID: "99", CI_PROJECT_PATH: "company/billing" }),
      {
        ...options,
        releasePrefix: "billing",
        repository: { id: 99, path: "company/billing" },
      },
    ),
  ).toMatchObject({ release: `billing@${sha}` });
  expect(
    validateGitLabContext(
      {
        ...context(),
        deployment: {
          environment: "staging",
          review: { provider: "gitlab", repositoryId: 7, number: 12 },
        },
      },
      gitlabEnv({
        CI_PROJECT_ID: "8",
        CI_PROJECT_PATH: "company/fork",
        CI_PIPELINE_SOURCE: "merge_request_event",
        CI_ENVIRONMENT_NAME: "review/pr-12",
        CI_MERGE_REQUEST_IID: "12",
        CI_MERGE_REQUEST_PROJECT_ID: "7",
        CI_MERGE_REQUEST_PROJECT_PATH: repository.path,
        CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "8",
        CI_MERGE_REQUEST_SOURCE_PROJECT_PATH: "company/fork",
      }),
      { ...options, environment: "staging", environmentName: "review/pr-12" },
    ),
  ).toMatchObject({ deployment: { environment: "staging" } });
});

it("prepares 129 maps as two private batches and keeps the public output free of maps", async () => {
  const root = await directory();
  const output = join(root, "build");
  const privateRoot = join(root, "private");

  await mkdir(output);
  await mkdir(privateRoot);

  for (let index = 0; index < 129; index += 1) {
    const js = join(output, `chunk-${index}.js`);

    await writeFile(
      js,
      `console.log(${index});\n//# sourceMappingURL=chunk-${index}.js.map`,
    );
    await writeFile(
      `${js}.map`,
      JSON.stringify({
        version: 3,
        sources: [`chunk-${index}.ts`],
        names: [],
        mappings: "AAAA",
        sourcesContent: [`console.log(${index});`],
      }),
    );
  }

  const maps = await prepareBuild(output, privateRoot, `account@${sha}`);
  const batches = (await readdir(maps)).sort();

  expect(batches).toEqual(["batch-001", "batch-002"]);
  expect((await readPrepared(join(maps, batches[0]!))).artifacts).toHaveLength(
    128,
  );
  expect((await readPrepared(join(maps, batches[1]!))).artifacts).toHaveLength(
    1,
  );
  expect(await readFile(join(output, "chunk-0.js"), "utf8")).toContain(
    "__GETEXCEPTION_DEBUG_IDS__",
  );
  await assertPublicOutput(output, { mapsEnabled: true });
});

it("keeps the public build intact when preparation has been cancelled", async () => {
  const root = await directory();
  const output = join(root, "build");
  const privateRoot = join(root, "private");
  const controller = new AbortController();

  await mkdir(output);
  await mkdir(privateRoot);
  await writeFile(join(output, "app.js"), "console.log(1);");
  await writeFile(join(output, "app.js.map"), "{}");
  controller.abort();
  await expect(
    prepareBuild(output, privateRoot, `account@${sha}`, controller.signal),
  ).rejects.toThrow();
  expect(await readFile(join(output, "app.js"), "utf8")).toBe(
    "console.log(1);",
  );
  expect(await readFile(join(output, "app.js.map"), "utf8")).toBe("{}");
});

it("separates build and deploy failures from optional monitoring failures", async () => {
  const root = await directory();
  const output = join(root, "build");
  const build = vi.fn(async (env: NodeJS.ProcessEnv) => {
    expect(env.GETEXCEPTION_GITLAB_ID_TOKEN).toBeUndefined();
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "app.js"), "console.log('safe');");
  });
  const deploy = vi.fn(async () => {});
  const transport: typeof fetch = vi.fn(async (input) => {
    const path = String(input);

    return new Response(
      JSON.stringify(
        path.endsWith("/ci?version=2")
          ? {
              version: 2,
              sourceMaps: { enabled: false, reason: "source_not_allowed" },
            }
          : {},
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const messages: string[] = [];
  const result = await deployWithGetException({
    url: "https://monitor.example.test",
    projectId,
    releasePrefix: "account",
    repository,
    environment: "staging",
    environmentName: "review/pr-12",
    output,
    env: gitlabEnv({
      CI_PIPELINE_SOURCE: "merge_request_event",
      CI_ENVIRONMENT_NAME: "review/pr-12",
      CI_MERGE_REQUEST_IID: "12",
      CI_MERGE_REQUEST_PROJECT_ID: "7",
      CI_MERGE_REQUEST_PROJECT_PATH: repository.path,
      CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "7",
      CI_MERGE_REQUEST_SOURCE_PROJECT_PATH: repository.path,
    }),
    build,
    deploy,
    transport,
    log: (message) => messages.push(message),
  });

  expect(result).toMatchObject({ maps: "disabled", registration: "skipped" });
  expect(build).toHaveBeenCalledOnce();
  expect(deploy).toHaveBeenCalledOnce();
  expect(messages).toHaveLength(1);

  build.mockRejectedValueOnce(new Error("compiler failed"));
  await expect(
    deployWithGetException({
      url: "https://monitor.example.test",
      projectId,
      releasePrefix: "account",
      repository,
      environment: "staging",
      environmentName: "review/pr-12",
      output,
      env: gitlabEnv({ GETEXCEPTION_GITLAB_ID_TOKEN: undefined }),
      build,
      deploy,
      log: () => {},
    }),
  ).rejects.toThrow("compiler failed");
  expect(deploy).toHaveBeenCalledOnce();
});

it("removes the process token before setup even with an injected environment", async () => {
  const root = await directory();
  const output = join(root, "build");
  const previous = process.env.GETEXCEPTION_GITLAB_ID_TOKEN;

  process.env.GETEXCEPTION_GITLAB_ID_TOKEN = identity;

  try {
    await deployWithGetException({
      url: "https://monitor.example.test",
      projectId,
      releasePrefix: "account",
      repository,
      environment: "staging",
      environmentName: "review/pr-12",
      output,
      env: gitlabEnv({ GETEXCEPTION_GITLAB_ID_TOKEN: undefined }),
      beforeBuild: async (safeEnv) => {
        expect(process.env.GETEXCEPTION_GITLAB_ID_TOKEN).toBeUndefined();
        expect(safeEnv.GETEXCEPTION_GITLAB_ID_TOKEN).toBeUndefined();
      },
      build: async () => {
        await mkdir(output);
        await writeFile(join(output, "app.js"), "console.log(1);");
      },
      deploy: async () => {},
      log: () => {},
    });
  } finally {
    if (previous === undefined) {
      delete process.env.GETEXCEPTION_GITLAB_ID_TOKEN;
    } else {
      process.env.GETEXCEPTION_GITLAB_ID_TOKEN = previous;
    }
  }
});

it("rebuilds without maps after failed preparation and registers only after deploy", async () => {
  const root = await directory();
  const output = join(root, "build");
  const sequence: string[] = [];
  const beforeBuild = vi.fn(async (safeEnv: NodeJS.ProcessEnv) => {
    expect(safeEnv.GETEXCEPTION_GITLAB_ID_TOKEN).toBeUndefined();
    sequence.push("beforeBuild");
  });
  const build = vi.fn(async (env: NodeJS.ProcessEnv) => {
    sequence.push("build");
    await rm(output, { recursive: true, force: true });
    await mkdir(output);
    await writeFile(join(output, "app.js"), "console.log(1);");

    if (env.GETEXCEPTION_SOURCE_MAPS === "true") {
      await writeFile(join(output, "app.js.map"), "invalid map");
    }
  });
  const deploy = vi.fn(async () => {
    sequence.push("deploy");
  });
  const transport: typeof fetch = vi.fn(async (input) => {
    const path = String(input);

    sequence.push(path.endsWith("/releases") ? "register" : "context");

    return new Response(
      JSON.stringify(path.endsWith("/ci?version=2") ? context() : {}),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const result = await deployWithGetException({
    url: "https://monitor.example.test",
    projectId,
    releasePrefix: "account",
    repository,
    environment: "production",
    environmentName: "production/app",
    output,
    env: gitlabEnv(),
    beforeBuild,
    runtimeEnv: {
      release: "APP_GETEXCEPTION_RELEASE",
      environment: "APP_GETEXCEPTION_ENVIRONMENT",
    },
    build,
    deploy,
    transport,
    log: () => {},
  });

  expect(build).toHaveBeenCalledTimes(2);
  expect(beforeBuild).toHaveBeenCalledOnce();
  expect(build.mock.calls[0]?.[0]).toMatchObject({
    GETEXCEPTION_SOURCE_MAPS: "true",
    APP_GETEXCEPTION_RELEASE: `account@${sha}`,
  });
  expect(build.mock.calls[1]?.[0]).toMatchObject({
    GETEXCEPTION_SOURCE_MAPS: "false",
  });
  expect(sequence).toEqual([
    "context",
    "beforeBuild",
    "build",
    "build",
    "deploy",
    "register",
  ]);
  expect(result).toMatchObject({ maps: "failed", registration: "registered" });
  await assertPublicOutput(output);
});

it("uploads prepared maps only after a successful application deployment", async () => {
  const root = await directory();
  const output = join(root, "build");
  const assets = join(output, "assets", "ge-gl-7-456");
  const sequence: string[] = [];
  const build = vi.fn(async (env: NodeJS.ProcessEnv) => {
    expect(env.GETEXCEPTION_GITLAB_ID_TOKEN).toBeUndefined();
    await mkdir(assets, { recursive: true });
    await writeFile(
      join(assets, "app.js"),
      "console.log(1);\n//# sourceMappingURL=app.js.map",
    );
    await writeFile(
      join(assets, "app.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["app.ts"],
        names: [],
        mappings: "AAAA",
        sourcesContent: ["console.log(1);"],
      }),
    );
  });
  const deploy = vi.fn(async () => {
    sequence.push("deploy");
    await expect(readFile(join(assets, "app.js.map"))).rejects.toThrow();
  });
  const response = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const transport: typeof fetch = vi.fn(async (input, init) => {
    const path = String(input);

    if (path.endsWith("/ci?version=2")) {
      sequence.push("context");

      return response(context());
    }

    if (path.endsWith("/releases")) {
      sequence.push("register");

      return response({});
    }

    if (path.endsWith("/source-maps") && init?.method === "POST") {
      sequence.push("begin");
      const manifest = JSON.parse(String(init.body)) as {
        artifacts: { path: string }[];
      };

      return response({
        uploadId: randomUUID(),
        status: "receiving",
        artifacts: manifest.artifacts.map((item) => ({
          id: randomUUID(),
          path: item.path,
          uploaded: false,
        })),
      });
    }

    if (init?.method === "PUT") {
      sequence.push("put");

      return response({ ok: true });
    }

    if (init?.method === "POST") {
      sequence.push("finalize");

      return response({ ok: true });
    }

    sequence.push("status");

    return response({ status: "ready" });
  });
  const result = await deployWithGetException({
    url: "https://monitor.example.test",
    projectId,
    releasePrefix: "account",
    repository,
    environment: "production",
    environmentName: "production/app",
    output,
    env: gitlabEnv(),
    build,
    deploy,
    transport,
    log: () => {},
  });

  expect(result).toMatchObject({ maps: "ready", registration: "registered" });
  expect(sequence).toEqual([
    "context",
    "deploy",
    "register",
    "begin",
    "put",
    "finalize",
    "status",
  ]);
});

it("blocks real inline maps while accepting a harmless string literal", async () => {
  const root = await directory();

  await writeFile(
    join(root, "app.js"),
    'const example = "//# sourceMappingURL=data:fake";',
  );
  await assertPublicOutput(root);
  await writeFile(
    join(root, "app.js"),
    "console.log(1);\n//# sourceMappingURL=data:evil",
  );
  await expect(assertPublicOutput(root)).rejects.toThrow("Inline source map");
  await writeFile(join(root, "app.js"), "console.log(1);");
  await writeFile(
    join(root, "app.css"),
    "body{}/*# sourceMappingURL=data:evil */",
  );
  await expect(assertPublicOutput(root)).rejects.toThrow("Inline source map");
});
