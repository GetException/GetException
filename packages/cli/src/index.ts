#!/usr/bin/env node
import { parseArgs } from "node:util";
import { prepareMaps } from "./prepare";
import { uploadMaps } from "./upload";
import { registerRelease } from "./releases";
import { ciCredential } from "./credentials";
import { buildContext } from "./ci";
import { formatDiagnostic } from "./diagnostics";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      output: { type: "string" },
      release: { type: "string" },
      "url-prefix": { type: "string" },
      url: { type: "string" },
      project: { type: "string" },
      environment: { type: "string" },
      "repository-id": { type: "string" },
      "merge-request": { type: "string" },
      help: { type: "boolean" },
    },
  });

  if (values.help) {
    process.stdout.write(
      "getexception sourcemaps prepare --dir dist --output ../private-maps --release app@<40-character-SHA> [--url-prefix assets]\ngetexception sourcemaps upload --dir ../private-maps --url https://dashboard.example --project <UUID>\ngetexception releases register --url https://dashboard.example --project <UUID> --release app@<40-character-SHA> --environment <production|staging|development> [--repository-id <GitLab project ID> --merge-request <IID>]\ngetexception ci context --url https://dashboard.example --project <UUID>\nAuthentication: GETEXCEPTION_UPLOAD_TOKEN or GETEXCEPTION_GITLAB_ID_TOKEN, never both. Prepare modifies ESM JavaScript and removes public .js.map files.\n",
    );

    return;
  }

  if (
    positionals.length === 2 &&
    positionals[0] === "ci" &&
    positionals[1] === "context" &&
    values.url &&
    values.project
  ) {
    process.stdout.write(
      JSON.stringify(
        await buildContext(values.url, values.project, ciCredential()),
      ) + "\n",
    );

    return;
  }

  if (
    positionals.length === 2 &&
    positionals[0] === "releases" &&
    positionals[1] === "register" &&
    values.url &&
    values.project
  ) {
    const hasReview =
      values["repository-id"] !== undefined ||
      values["merge-request"] !== undefined;

    await registerRelease(values.url, values.project, ciCredential(), {
      release: values.release,
      deployment: {
        environment: values.environment,
        ...(hasReview
          ? {
              review: {
                provider: "gitlab",
                repositoryId: Number(values["repository-id"]),
                number: Number(values["merge-request"]),
              },
            }
          : {}),
      },
    });
    process.stdout.write("Release environment registered.\n");

    return;
  }

  if (
    positionals.length !== 2 ||
    positionals[0] !== "sourcemaps" ||
    !values.dir
  ) {
    throw new Error("Invalid command");
  }

  if (positionals[1] === "prepare" && values.output && values.release) {
    const result = await prepareMaps(
      values.dir,
      values.output,
      values.release,
      values["url-prefix"],
    );

    process.stdout.write(
      `Prepared ${result.artifacts.length} private source maps.\n`,
    );
  } else if (positionals[1] === "upload" && values.url && values.project) {
    await uploadMaps(values.dir, values.url, values.project, ciCredential());
    process.stdout.write("Source maps validated and ready.\n");
  } else {
    throw new Error("Invalid command");
  }
}

void main().catch((error: unknown) => {
  // Never echo arguments, token values, maps, or server response bodies.
  process.stderr.write(formatDiagnostic(error));
  process.exitCode = 1;
});
