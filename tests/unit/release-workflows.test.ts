import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Workflow = {
  on: Record<string, unknown>;
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string | string[];
      permissions?: Record<string, string>;
      steps?: {
        uses?: string;
        run?: string;
        env?: Record<string, string>;
        with?: Record<string, unknown>;
      }[];
    }
  >;
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
  it("uploads required reports and fixtures from the hidden artifacts directory", () => {
    for (const name of ["release", "sdk-release"]) {
      const steps = Object.values(workflow(name).jobs).flatMap(
        (job) => job.steps ?? [],
      );

      for (const step of steps) {
        if (
          step.uses?.startsWith("actions/upload-artifact@") &&
          String(step.with?.path).includes(".artifacts/")
        ) {
          expect(step.with?.["include-hidden-files"]).toBe(true);
          expect(step.with?.["if-no-files-found"]).toBe("error");
          expect(step.with?.path).not.toBe(".artifacts/");
        }
      }
    }
  });

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

  it("uses the repository deploy key for the version commit and the built-in token for dispatch", () => {
    const config = workflow("prepare-release");
    const job = config.jobs["prepare-release"];
    const steps = job.steps ?? [];
    const checkout = steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const prepare = steps.find((step) => step.run?.includes("prepare.py"));
    const access = steps.findIndex((step) =>
      step.run?.includes("git push --dry-run"),
    );
    const install = steps.findIndex((step) =>
      step.run?.includes("yarn install"),
    );

    expect(checkout?.with).toMatchObject({
      "ssh-key": "${{ secrets.DEPLOY_KEY }}",
      "ssh-strict": true,
      "persist-credentials": true,
      "fetch-depth": 0,
    });
    expect(checkout?.with?.token).toBeUndefined();
    expect(steps[0].run).toContain("refs/heads/stable");
    expect(steps[0].env?.REPOSITORY_SSH_KEY).toBe("${{ secrets.DEPLOY_KEY }}");
    expect(access).toBeGreaterThan(0);
    expect(access).toBeLessThan(install);
    expect(steps[access].run).toContain("git fetch origin stable");
    expect(steps[access].run).toContain(
      "refs/remotes/origin/stable:refs/heads/stable",
    );
    expect(prepare?.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(job.permissions).toEqual({ contents: "read", actions: "write" });
    expect(JSON.stringify(config)).not.toMatch(
      /RELEASE_TOKEN|NPM_TOKEN|SSH_KEY }}/,
    );
    expect(JSON.stringify(workflow("sdk-release"))).not.toContain("DEPLOY_KEY");
  });

  it("uses the configured server credentials independently from the repository deploy key", () => {
    const job = workflow("release").jobs.deploy;
    const deploy = job.steps?.find((step) =>
      step.run?.includes("ssh-deploy.py"),
    );

    expect(job.if).toBe("${{ vars.DEPLOY_ENABLED == 'true' }}");
    expect(deploy?.env).toMatchObject({
      DEPLOY_HOST: "${{ vars.SSH_HOST || vars.DEPLOY_HOST }}",
      DEPLOY_USER: "${{ vars.SSH_USER || vars.DEPLOY_USER }}",
      DEPLOY_SSH_KEY: "${{ secrets.SSH_KEY || secrets.DEPLOY_SSH_KEY }}",
      DEPLOY_KNOWN_HOSTS:
        "${{ secrets.SSH_KNOWN_HOSTS || secrets.DEPLOY_KNOWN_HOSTS }}",
      RELEASE_SHA: "${{ github.sha }}",
    });
    expect(JSON.stringify(job)).not.toContain("secrets.DEPLOY_KEY");
  });

  it("allows the write-access check to rerun after a release commit without changing the remote", () => {
    const steps = workflow("prepare-release").jobs["prepare-release"].steps;
    const script = steps?.find((step) =>
      step.run?.includes("git push --dry-run"),
    )?.run;
    const directory = mkdtempSync(join(tmpdir(), "getexception-write-check-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    try {
      git("init", "--bare", "--initial-branch=stable", "remote.git");
      git("init", "--initial-branch=stable");
      git("config", "user.name", "Release test");
      git("config", "user.email", "release@example.com");
      git("config", "commit.gpgsign", "false");
      git("remote", "add", "origin", join(directory, "remote.git"));
      git("commit", "--allow-empty", "-m", "Source");

      const source = git("rev-parse", "HEAD");

      git("commit", "--allow-empty", "-m", "Prepared release [skip ci]");
      git("push", "origin", "stable");

      const remote = git("ls-remote", "origin", "refs/heads/stable");

      git("checkout", "--detach", source);
      execFileSync("bash", ["-e", "-c", script ?? "exit 1"], {
        cwd: directory,
        stdio: "pipe",
      });
      expect(git("ls-remote", "origin", "refs/heads/stable")).toBe(remote);
      expect(git("rev-parse", "HEAD")).toBe(source);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
