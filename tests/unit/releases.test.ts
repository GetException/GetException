import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { releaseRegistrationSchema } from "../../packages/protocol/src/releases";
import { ReleaseContext } from "../../apps/web/src/components/releases/ReleaseContext";
import {
  releaseFilters,
  releaseWhere,
} from "../../apps/web/src/server/releases/filters";
import { reviewLabel } from "../../apps/web/src/components/releases/presentation";

it("accepts only bounded CI metadata and never accepts arbitrary URLs or production MR labels", () => {
  const value = {
    release: `account@${"a".repeat(40)}`,
    deployment: {
      environment: "staging",
      review: { provider: "gitlab", repositoryId: 12, number: 34 },
    },
  };

  expect(releaseRegistrationSchema.parse(value)).toEqual(value);

  for (const review of [
    { ...value.deployment.review, number: -1 },
    { ...value.deployment.review, number: 2147483648 },
    { ...value.deployment.review, url: "javascript:alert(1)" },
  ]) {
    expect(
      releaseRegistrationSchema.safeParse({
        ...value,
        deployment: { ...value.deployment, review },
      }).success,
    ).toBe(false);
  }

  expect(
    releaseRegistrationSchema.safeParse({
      ...value,
      deployment: { ...value.deployment, environment: "production" },
    }).success,
  ).toBe(false);
});

it("keeps environment and review filters inside the authorized project scope", () => {
  const filters = releaseFilters({
    project: "foreign",
    environment: "staging",
    review: "gitlab:12:34",
    page: "9999999",
  });

  expect(filters.page).toBe(200);
  expect(
    releaseWhere(
      { id: "viewer", organizationId: "workspace", role: "viewer" },
      filters,
    ),
  ).toMatchObject({
    project: {
      id: "foreign",
      organizationId: "workspace",
      deletedAt: null,
      teams: { some: { team: { members: { some: { memberId: "viewer" } } } } },
    },
    deployments: {
      some: { environment: "staging", reviewKey: "gitlab:12:34" },
    },
  });
  expect(
    releaseFilters({ environment: ["production"], review: "<script>" }),
  ).toMatchObject({ environment: "all", review: "" });
});

it("shows every observed environment, deduplicates MR labels, and never guesses an MR from staging", () => {
  const deployments = [
    { environment: "production", reviewKey: "", registeredAt: null },
    { environment: "staging", reviewKey: "", registeredAt: null },
    {
      environment: "staging",
      reviewKey: "gitlab:12:34",
      registeredAt: new Date(),
    },
  ];
  const html = renderToStaticMarkup(
    createElement(ReleaseContext, { projectId: "project", deployments }),
  );

  expect(html).toContain("Production");
  expect(html).toContain("Preview / staging");
  expect(html.match(/MR !34/g)).toHaveLength(1);
  expect(html).toContain("review=gitlab%3A12%3A34");
  expect(
    renderToStaticMarkup(
      createElement(ReleaseContext, {
        projectId: "project",
        deployments: deployments.slice(0, 2),
      }),
    ),
  ).not.toContain("MR !");
  expect(
    renderToStaticMarkup(
      createElement(ReleaseContext, { projectId: "project", deployments: [] }),
    ),
  ).toContain("Unknown environment");
  expect(reviewLabel("gitlab:1:<script>")).toBeUndefined();
});
