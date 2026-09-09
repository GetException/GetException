import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Workflow = {
  on: Record<string, unknown>;
  jobs: Record<string, { needs?: string | string[]; steps?: unknown[] }>;
};

function workflow(name: string): Workflow {
  return parse(readFileSync(`.github/workflows/${name}.yml`, "utf8"));
}

function dependencies(config: Workflow, job: string): string[] {
  const needs = config.jobs[job]?.needs ?? [];

  return [needs]
    .flat()
    .flatMap((name) => [name, ...dependencies(config, name)]);
}

describe("independent server and SDK releases", () => {
  it("can deploy a stable push without npm credentials or SDK publication", () => {
    const config = workflow("release");
    const jobs = dependencies(config, "deploy");

    expect(config.on.push).toEqual({ branches: ["stable"] });
    expect(jobs).toEqual(
      expect.arrayContaining([
        "checks",
        "build-images",
        "publish-bootstrap",
        "bootstrap-e2e",
        "promote-release",
      ]),
    );
    expect(JSON.stringify(config)).not.toMatch(
      /NPM_TOKEN|release:packages|release:registry-smoke|Release-Source:/,
    );
    expect(JSON.stringify(config.jobs["build-images"])).toContain(
      "--fail-on critical",
    );
    expect(JSON.stringify(config.jobs["bootstrap-e2e"])).toContain(
      "--published",
    );
    expect(JSON.stringify(config.jobs["bootstrap-e2e"])).toContain(
      "yarn generate && yarn build",
    );
  });

  it("publishes SDKs only through manual workflows and validates registry packages", () => {
    const config = workflow("sdk-release");

    expect(Object.keys(workflow("prepare-release").on)).toEqual([
      "workflow_dispatch",
    ]);
    expect(Object.keys(config.on)).toEqual(["workflow_dispatch"]);
    expect(dependencies(config, "sdk-e2e")).toEqual(
      expect.arrayContaining(["checks", "publish-packages", "registry-smoke"]),
    );
    expect(JSON.stringify(config.jobs["sdk-e2e"])).toContain(
      "--registry-fixtures",
    );
    expect(config.jobs.deploy).toBeUndefined();

    for (const [name, job] of Object.entries(config.jobs)) {
      if (name !== "publish-packages") {
        expect(JSON.stringify(job)).not.toContain("NPM_TOKEN");
      }
    }
  });
});
