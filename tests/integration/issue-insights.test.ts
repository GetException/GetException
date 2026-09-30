import { afterAll, beforeAll, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase } from "@getexception/db";
import { temporaryDatabase } from "./database";
import {
  issueTrend,
  latestIssueEvents,
} from "../../apps/web/src/server/issues/insights";
import { issueFilters, issueWhere } from "../../apps/web/src/server/filters";

let instance: Awaited<ReturnType<typeof temporaryDatabase>>;
let web: ReturnType<typeof createDatabase>;
let projectId: string;
let issueId: string;
let organizationId: string;
const previewRelease = `account@${"a".repeat(40)}`;
const productionRelease = `account@${"b".repeat(40)}`;

beforeAll(async () => {
  instance = await temporaryDatabase();
  web = createDatabase(instance.urls.web);
  const organization = await instance.admin.organization.create({
    data: { id: randomUUID(), name: "Issue insights", slug: "issue-insights" },
  });
  const project = await instance.admin.project.create({
    data: {
      organizationId: organization.id,
      name: "account",
      slug: "account",
    },
  });
  const issue = await instance.admin.issue.create({
    data: {
      projectId: project.id,
      fingerprint: "insight",
      title: "Preview error",
      exceptionType: "TypeError",
      eventCount: 3,
      firstSeen: new Date("2026-09-19T10:00:00Z"),
      lastSeen: new Date("2026-09-21T10:00:00Z"),
    },
  });

  projectId = project.id;
  issueId = issue.id;
  organizationId = organization.id;

  for (const [receivedAt, environment, release, symbolicationState] of [
    ["2026-09-19T10:00:00Z", "staging", previewRelease, "partial"],
    ["2026-09-19T11:00:00Z", "staging", previewRelease, "missing"],
    ["2026-09-21T10:00:00Z", "production", productionRelease, "missing"],
  ] as const) {
    await instance.admin.errorEvent.create({
      data: {
        projectId,
        issueId,
        eventId: randomBytes(16).toString("hex"),
        receivedAt: new Date(receivedAt),
        timestamp: new Date(receivedAt),
        environment,
        release,
        symbolicationState,
        level: "error",
        message: "Preview error",
        exceptionType: "TypeError",
        handled: false,
        frames: [],
        breadcrumbs: [],
        tags: {},
      },
    });
  }
});

it("finds source context in an older event without confusing another environment", async () => {
  const member = { id: "owner", role: "owner" as const, organizationId };
  const selected = { environment: "staging", release: previewRelease };
  const [mapped, unmapped, production] = await Promise.all([
    web.issue.count({
      where: issueWhere(
        member,
        issueFilters({ ...selected, source: "mapped" }),
      ),
    }),
    web.issue.count({
      where: issueWhere(
        member,
        issueFilters({ ...selected, source: "unmapped" }),
      ),
    }),
    web.issue.count({
      where: issueWhere(
        member,
        issueFilters({ environment: "production", source: "unmapped" }),
      ),
    }),
  ]);
  const latestMapped = await latestIssueEvents(web, [issueId], {
    ...selected,
    source: "mapped",
  });

  expect([mapped, unmapped, production]).toEqual([1, 0, 1]);
  expect(latestMapped[0]).toMatchObject({
    issueId,
    symbolicationState: "partial",
    environment: "staging",
  });
});

afterAll(async () => {
  await web?.$disconnect();
  await instance?.cleanup();
});

it("uses the selected environment and release for the latest visible issue event", async () => {
  const [all, preview, production] = await Promise.all([
    latestIssueEvents(web, [issueId], { environment: "all", release: "" }),
    latestIssueEvents(web, [issueId], {
      environment: "staging",
      release: previewRelease,
    }),
    latestIssueEvents(web, [issueId], {
      environment: "production",
      release: productionRelease,
    }),
  ]);

  expect(all[0]).toMatchObject({
    issueId,
    environment: "production",
    release: productionRelease,
  });
  expect(preview[0]).toMatchObject({
    issueId,
    environment: "staging",
    release: previewRelease,
  });
  expect(production[0]).toMatchObject({
    issueId,
    environment: "production",
    release: productionRelease,
  });
  expect(
    await latestIssueEvents(web, ["missing"], {
      environment: "all",
      release: "",
    }),
  ).toEqual([]);
});

it("counts seven UTC days without loading individual event payloads", async () => {
  const days = await issueTrend(
    web,
    projectId,
    issueId,
    new Date("2026-09-21T23:00:00Z"),
  );

  expect(days).toHaveLength(7);
  expect(days[4]).toEqual({ date: "2026-09-19", count: 2 });
  expect(days[6]).toEqual({ date: "2026-09-21", count: 1 });
  expect(days.reduce((sum, day) => sum + day.count, 0)).toBe(3);
});
