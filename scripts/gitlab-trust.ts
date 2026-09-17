import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { createGitlabTrust } from "./gitlab-trust-config";

async function main() {
  const { values } = parseArgs({
    options: {
      gitlab: { type: "string" },
      project: { type: "string" },
      "repository-id": { type: "string" },
      "repository-path": { type: "string" },
      "release-prefix": { type: "string" },
      output: { type: "string" },
      "production-environment": { type: "string" },
      "production-ref": { type: "string", multiple: true },
    },
  });

  if (!values.output) {
    throw new Error("Use a new output file");
  }

  const policy = await createGitlabTrust({
    gitlab: values.gitlab ?? "",
    projectId: values.project ?? "",
    repositoryId: Number(values["repository-id"]),
    repositoryPath: values["repository-path"] ?? "",
    releasePrefix: values["release-prefix"] ?? "",
    productionEnvironment: values["production-environment"],
    productionRefs: values["production-ref"],
  });

  await writeFile(values.output, JSON.stringify(policy) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    "Public GitLab trust policy written. Review bindings before installing it as GITLAB_CI_TRUST.\n",
  );
}

void main().catch(() => {
  process.stderr.write(
    "Unable to create trust policy. Check HTTPS origin, project identifiers, output path and public verification keys.\n",
  );
  process.exitCode = 1;
});
