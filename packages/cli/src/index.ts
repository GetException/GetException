#!/usr/bin/env node
import { parseArgs } from "node:util";
import { prepareMaps } from "./prepare";
import { uploadMaps } from "./upload";
import { registerRelease } from "./releases";

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
      "getexception sourcemaps prepare --dir dist --output ../private-maps --release app@<40-character-SHA> [--url-prefix assets]\ngetexception sourcemaps upload --dir ../private-maps --url https://dashboard.example --project <UUID>\ngetexception releases register --url https://dashboard.example --project <UUID> --release app@<40-character-SHA> --environment <production|staging|development> [--repository-id <GitLab project ID> --merge-request <IID>]\nToken: GETEXCEPTION_UPLOAD_TOKEN environment variable. Prepare modifies ESM JavaScript and removes public .js.map files.\n",
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

    await registerRelease(
      values.url,
      values.project,
      process.env.GETEXCEPTION_UPLOAD_TOKEN ?? "",
      {
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
      },
    );
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
    await uploadMaps(
      values.dir,
      values.url,
      values.project,
      process.env.GETEXCEPTION_UPLOAD_TOKEN ?? "",
    );
    process.stdout.write("Source maps validated and ready.\n");
  } else {
    throw new Error("Invalid command");
  }
}

void main().catch(() => {
  // Never echo arguments, token values, maps, or server response bodies.
  process.stderr.write(
    "Command failed. Check options (--help), CI token, limits and private artifacts; retry upload without rebuilding.\n",
  );
  process.exitCode = 1;
});
