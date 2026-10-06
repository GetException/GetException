import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ciContextSchema,
  sanitizeAppVersion,
  type CiContext,
} from "@getexception/protocol";
import { buildContext } from "./ci";
import { type CiCredential } from "./credentials";
import { CliError } from "./diagnostics";
import { prepareBuild } from "./prepare-build";
import { assertPublicOutput } from "./public-output";
import { registerRelease } from "./releases";
import { uploadMaps } from "./upload";

export type GitLabDeploymentOptions = {
  url: string;
  projectId: string;
  releasePrefix: string;
  appVersion?: string;
  repository: { id: number; path: string };
  environment: "production" | "staging";
  environmentName: string;
  output: string;
  beforeBuild?: (environment: NodeJS.ProcessEnv) => Promise<void>;
  build: (environment: NodeJS.ProcessEnv) => Promise<void>;
  deploy: () => Promise<void>;
  runtimeEnv?: { release: string; environment: string };
  env?: NodeJS.ProcessEnv;
  transport?: typeof fetch;
  log?: (message: string) => void;
};

export type GitLabDeploymentResult = {
  maps: "ready" | "disabled" | "failed" | "incomplete";
  registration: "registered" | "failed" | "skipped";
  diagnostic?: string;
  cleanupFailed: boolean;
};

function validId(value: string | undefined) {
  return /^[1-9][0-9]*$/.test(value ?? "");
}

export function validateGitLabContext(
  value: unknown,
  env: NodeJS.ProcessEnv,
  options: Pick<
    GitLabDeploymentOptions,
    "releasePrefix" | "repository" | "environment" | "environmentName"
  >,
) {
  const parsed = ciContextSchema.safeParse(value);

  if (!parsed.success) {
    throw new CliError("CONTRACT_RESPONSE");
  }

  const context = parsed.data;
  const job = env.CI_JOB_ID;
  const sha = env.CI_COMMIT_SHA;
  const repositoryId = String(options.repository.id);
  const primary =
    env.CI_PROJECT_ID === repositoryId &&
    env.CI_PROJECT_PATH === options.repository.path;
  const review =
    options.environment === "staging" &&
    env.CI_PIPELINE_SOURCE === "merge_request_event";

  if (
    env.GITLAB_CI !== "true" ||
    !validId(job) ||
    !/^[a-f0-9]{40}$/.test(sha ?? "") ||
    env.CI_ENVIRONMENT_NAME !== options.environmentName
  ) {
    throw new CliError("CONTRACT_RESPONSE");
  }

  if (options.environment === "production") {
    if (
      !primary ||
      env.CI_COMMIT_REF_PROTECTED !== "true" ||
      !["push", "web"].includes(env.CI_PIPELINE_SOURCE ?? "")
    ) {
      throw new CliError("CONTRACT_RESPONSE");
    }
  } else if (review) {
    const sourceId = env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID;
    const sourcePath = env.CI_MERGE_REQUEST_SOURCE_PROJECT_PATH;
    const sourceExecution =
      env.CI_PROJECT_ID === sourceId && env.CI_PROJECT_PATH === sourcePath;

    if (
      !validId(sourceId) ||
      !sourcePath ||
      !validId(env.CI_MERGE_REQUEST_IID) ||
      (sourceId === repositoryId) !==
        (sourcePath === options.repository.path) ||
      (!primary && !sourceExecution) ||
      env.CI_MERGE_REQUEST_PROJECT_ID !== repositoryId ||
      env.CI_MERGE_REQUEST_PROJECT_PATH !== options.repository.path
    ) {
      throw new CliError("CONTRACT_RESPONSE");
    }
  } else if (
    !primary ||
    !["push", "web"].includes(env.CI_PIPELINE_SOURCE ?? "")
  ) {
    throw new CliError("CONTRACT_RESPONSE");
  }

  if (!("release" in context)) {
    if (options.environment !== "staging") {
      throw new CliError("CONTRACT_RESPONSE");
    }

    return context;
  }

  if (
    context.release !== `${options.releasePrefix}@${sha}` ||
    context.assetPrefix !== `assets/ge-gl-${repositoryId}-${job}/` ||
    context.deployment.environment !== options.environment ||
    (review
      ? context.deployment.review?.provider !== "gitlab" ||
        context.deployment.review.repositoryId !== options.repository.id ||
        context.deployment.review.number !== Number(env.CI_MERGE_REQUEST_IID)
      : context.deployment.review !== undefined)
  ) {
    throw new CliError("CONTRACT_RESPONSE");
  }

  return context;
}

function safeDiagnostic(error: unknown) {
  return error instanceof CliError ? error.code : "COMMAND_FAILED";
}

function report(
  result: GitLabDeploymentResult,
  environment: GitLabDeploymentOptions["environment"],
  log: (message: string) => void,
) {
  const ok =
    result.maps === "ready" &&
    result.registration !== "failed" &&
    !result.cleanupFailed;
  const warning = environment === "production" && !ok;
  const message =
    result.maps === "ready"
      ? "Source maps ready."
      : result.maps === "disabled"
        ? "Source maps disabled."
        : "Source maps unavailable; deployment continues.";

  log(
    `[getexception] ${warning ? "WARNING: " : ""}${message}${result.registration === "failed" ? " Release registration failed." : ""}${result.diagnostic ? ` ${result.diagnostic}` : ""}${result.cleanupFailed ? " CLEANUP_FAILED" : ""}`,
  );
}

export async function deployWithGetException(
  options: GitLabDeploymentOptions,
): Promise<GitLabDeploymentResult> {
  const env = options.env ?? process.env;
  const identity = env.GETEXCEPTION_GITLAB_ID_TOKEN;
  const legacyToken = env.GETEXCEPTION_UPLOAD_TOKEN;
  const safeEnv = { ...env };

  delete safeEnv.GETEXCEPTION_GITLAB_ID_TOKEN;
  delete safeEnv.GETEXCEPTION_UPLOAD_TOKEN;
  delete process.env.GETEXCEPTION_GITLAB_ID_TOKEN;
  delete process.env.GETEXCEPTION_UPLOAD_TOKEN;

  const release = /^[a-f0-9]{40}$/.test(env.CI_COMMIT_SHA ?? "")
    ? `${options.releasePrefix}@${env.CI_COMMIT_SHA}`
    : "";
  const buildEnv: NodeJS.ProcessEnv = {
    ...safeEnv,
    GETEXCEPTION_SOURCE_MAPS: "false",
    GETEXCEPTION_BUILD_NAMESPACE: "",
    GETEXCEPTION_RELEASE: release,
    GETEXCEPTION_ENVIRONMENT: options.environment,
  };
  const result: GitLabDeploymentResult = {
    maps: "disabled",
    registration: "skipped",
    cleanupFailed: false,
  };
  const setRuntimeEnv = (selectedRelease: string, environment: string) => {
    if (options.runtimeEnv) {
      buildEnv[options.runtimeEnv.release] = selectedRelease;
      buildEnv[options.runtimeEnv.environment] = environment;
    }
  };

  setRuntimeEnv(release, options.environment);
  let context: Extract<CiContext, { release: string }> | undefined;
  let credential: CiCredential | undefined;
  let privateRoot: string | undefined;
  let mapsDirectory: string | undefined;
  let deployed = false;

  try {
    if (!identity || legacyToken) {
      result.maps = "failed";
      result.diagnostic = legacyToken
        ? "CLI_CONFIGURATION"
        : "CI_TOKEN_MISSING";
    } else {
      credential = { gitlabIdToken: identity };

      try {
        const response = validateGitLabContext(
          await buildContext(
            options.url,
            options.projectId,
            credential,
            options.transport,
          ),
          env,
          options,
        );

        if ("release" in response) {
          context = response;
          buildEnv.GETEXCEPTION_SOURCE_MAPS = String(
            response.sourceMaps.enabled,
          );
          buildEnv.GETEXCEPTION_BUILD_NAMESPACE = response.assetPrefix.slice(
            "assets/ge-".length,
            -1,
          );
          buildEnv.GETEXCEPTION_RELEASE = response.release;
          setRuntimeEnv(response.release, response.deployment.environment);
        }

        result.maps =
          "release" in response && response.sourceMaps.enabled
            ? "incomplete"
            : "disabled";
      } catch (error) {
        result.maps = "failed";
        result.diagnostic = safeDiagnostic(error);
      }
    }

    await options.beforeBuild?.({ ...safeEnv });
    await options.build({ ...buildEnv });

    if (context?.sourceMaps.enabled) {
      try {
        privateRoot = await mkdtemp(join(tmpdir(), "getexception-ci-"));
        mapsDirectory = await prepareBuild(
          options.output,
          privateRoot,
          context.release,
        );
      } catch {
        // Preparation may have modified JavaScript. Build afresh without maps;
        // a failed compiler or an unsafe fallback output must still stop deploy.
        result.maps = "failed";
        result.diagnostic = "PREPARE_FAILED";
        buildEnv.GETEXCEPTION_SOURCE_MAPS = "false";
        buildEnv.GETEXCEPTION_BUILD_NAMESPACE = "";
        await options.build({ ...buildEnv });
      }
    }

    await assertPublicOutput(options.output, {
      assetPrefix: mapsDirectory ? context?.assetPrefix : undefined,
      credentials: [identity ?? "", legacyToken ?? ""],
      mapsEnabled: Boolean(mapsDirectory),
    });

    await options.deploy();
    deployed = true;

    if (context && credential) {
      try {
        await registerRelease(
          options.url,
          options.projectId,
          credential,
          {
            release: context.release,
            appVersion: sanitizeAppVersion(options.appVersion),
            deployment: context.deployment,
          },
          options.transport,
        );
        result.registration = "registered";
      } catch (error) {
        result.registration = "failed";
        result.diagnostic = safeDiagnostic(error);
      }
    }

    if (mapsDirectory && credential) {
      let failed = false;

      try {
        for (const name of (await readdir(mapsDirectory)).sort()) {
          try {
            await uploadMaps(
              join(mapsDirectory, name),
              options.url,
              options.projectId,
              credential,
              options.transport,
            );
          } catch (error) {
            failed = true;
            result.diagnostic = safeDiagnostic(error);
          }
        }
      } catch (error) {
        failed = true;
        result.diagnostic = safeDiagnostic(error);
      }

      result.maps = failed ? "incomplete" : "ready";
    }

    return result;
  } finally {
    if (privateRoot) {
      try {
        await rm(privateRoot, { recursive: true, force: true });
      } catch {
        result.cleanupFailed = true;
      }
    }

    if (deployed) {
      report(result, options.environment, options.log ?? console.log);
    }
  }
}
