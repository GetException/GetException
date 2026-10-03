import { afterAll, beforeAll, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase } from "@getexception/db";
import { temporaryDatabase } from "./database";
import { latestIssueEvents } from "../../apps/web/src/server/issues/insights";
import { issueFilters, issueWhere } from "../../apps/web/src/server/filters";

import {
  eventActivity,
  eventBreakdowns,
} from "../../apps/web/src/server/analytics/activity";
import { overviewData } from "../../apps/web/src/server/analytics/overview";
import {
  activityFilters,
  activityWindow,
} from "../../apps/web/src/lib/activity";

let instance: Awaited<ReturnType<typeof temporaryDatabase>>;
let web: ReturnType<typeof createDatabase>;
let projectId: string;
let issueId: string;
let organizationId: string;
const now = new Date("2026-09-21T23:00:00Z");
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
      regression: true,
      firstSeen: new Date("2026-09-19T10:00:00Z"),
      lastSeen: new Date("2026-09-21T10:00:00Z"),
    },
  });

  projectId = project.id;
  issueId = issue.id;
  organizationId = organization.id;

  await instance.admin.release.createMany({
    data: [
      { id: "preview-release", projectId, name: previewRelease },
      { id: "production-release", projectId, name: productionRelease },
    ],
  });
  await instance.admin.releaseDeployment.create({
    data: {
      releaseId: "preview-release",
      environment: "staging",
      reviewKey: "gitlab:7:554",
    },
  });

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
        handled: environment === "production",
        browserName: environment === "production" ? "Firefox" : "Chrome",
        browserMajor: environment === "production" ? 150 : 153,
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

it("counts and splits exactly the selected event window and environment", async () => {
  const member = { id: "owner", role: "owner", organizationId };
  const filters = activityFilters({ period: "7d" });
  const window = activityWindow("7d", now);
  const activity = await eventActivity(web, member, filters, window, issueId);
  const preview = await eventActivity(
    web,
    member,
    { ...filters, environment: "staging" },
    window,
    issueId,
  );
  const day = await eventActivity(
    web,
    member,
    filters,
    activityWindow("24h", now),
    issueId,
  );

  expect(activity).toMatchObject({
    total: 3,
    unhandled: 2,
    mapped: 1,
    fatal: 0,
  });
  expect(activity.buckets).toHaveLength(7);
  expect(activity.buckets[4]).toMatchObject({
    count: 2,
    staging: 2,
    unhandled: 2,
  });
  expect(activity.buckets[6]).toMatchObject({
    count: 1,
    production: 1,
    handled: 1,
  });
  expect(activity.buckets[0]?.count).toBe(0);
  expect(preview.total).toBe(2);
  expect(day.total).toBe(1);

  const breakdown = await eventBreakdowns(
    web,
    member,
    filters,
    window,
    issueId,
  );

  expect(breakdown.browsers).toEqual([
    { label: "Chrome 153", count: 2 },
    { label: "Firefox 150", count: 1 },
  ]);
  expect(
    breakdown.releases.map(({ label, count }) => ({ label, count })),
  ).toEqual([
    { label: previewRelease, count: 2 },
    { label: productionRelease, count: 1 },
  ]);
});

it("keeps overview counts, issue drilldowns and top issues in the same view", async () => {
  const member = { id: "owner", role: "owner", organizationId };
  const filters = activityFilters({
    period: "7d",
    environment: "staging",
    project: projectId,
  });
  const overview = await overviewData(
    web,
    member,
    filters,
    activityWindow("7d", now),
  );

  expect(overview.open).toBe(1);
  expect(overview.regressions).toBe(1);
  expect(overview.releases).toHaveLength(1);
  expect(overview.releases[0]).toMatchObject({
    id: "preview-release",
    deployments: [{ environment: "staging", reviewKey: "gitlab:7:554" }],
  });
  expect(overview.topIssues).toHaveLength(1);
  expect(overview.topIssues[0]).toMatchObject({
    id: issueId,
    matchingEvents: 2,
    latest: new Date("2026-09-19T11:00:00Z"),
  });
  expect(overview.health).toEqual([
    {
      id: projectId,
      name: "account",
      slug: "account",
      events: 2,
      openIssues: 1,
    },
  ]);
  expect(
    await web.errorEvent.findFirst({
      where: { eventId: overview.topIssues[0]!.eventId },
    }),
  ).toMatchObject({ environment: "staging" });
  expect(
    await web.issue.count({
      where: issueWhere(
        member,
        issueFilters({ ...filters, status: "open" }),
        now.getTime(),
      ),
    }),
  ).toBe(overview.open);

  const dailyPreview = activityFilters({
    period: "24h",
    environment: "staging",
    project: projectId,
  });
  const daily = await overviewData(
    web,
    member,
    dailyPreview,
    activityWindow("24h", now),
  );

  expect(daily.open).toBe(0);
  expect(daily.topIssues).toEqual([]);
  expect(
    await web.issue.count({
      where: issueWhere(member, issueFilters(dailyPreview), now.getTime()),
    }),
  ).toBe(0);
  expect(
    await latestIssueEvents(
      web,
      [issueId],
      { ...dailyPreview, release: "" },
      now,
    ),
  ).toEqual([]);
});

it("does not expose event aggregates to members without access", async () => {
  const filters = activityFilters({ period: "7d", project: projectId });
  const window = activityWindow("7d", now);

  for (const member of [
    { id: "no-teams", role: "viewer", organizationId },
    { id: "owner", role: "owner", organizationId: "another-organization" },
  ]) {
    expect((await eventActivity(web, member, filters, window)).total).toBe(0);
    expect(await eventBreakdowns(web, member, filters, window)).toEqual({
      browsers: [],
      releases: [],
    });
    expect(await overviewData(web, member, filters, window)).toMatchObject({
      projects: [],
      open: 0,
      regressions: 0,
      health: [],
      topIssues: [],
      releases: [],
    });
  }
});

it("counts beyond the former 25,000-event cap, excludes boundary events and enforces live team access", async () => {
  const db = instance.admin;
  const project = await db.project.create({
    data: { organizationId, name: "Volume", slug: "volume" },
  });
  const issue = await db.issue.create({
    data: {
      projectId: project.id,
      fingerprint: "volume",
      title: "Volume test",
      exceptionType: "Error",
      eventCount: 25005,
      firstSeen: now,
      lastSeen: now,
    },
  });
  const window = activityWindow("24h", now);

  await db.$executeRaw`
    INSERT INTO error_event (id, "projectId", "eventId", "issueId", "receivedAt", timestamp,
      level, message, "exceptionType", handled, environment, frames, tags, breadcrumbs)
    SELECT 'bulk-' || n, ${project.id}, md5('bulk-' || n), ${issue.id},
      CASE WHEN n = 25002 THEN ${window.start}::timestamptz
        WHEN n = 25003 THEN ${window.start}::timestamptz - interval '1 millisecond'
        WHEN n = 25004 THEN ${window.end}::timestamptz
        WHEN n = 25005 THEN ${window.end}::timestamptz + interval '1 millisecond'
        ELSE ${window.end}::timestamptz - interval '1 second' END,
      ${now}::timestamptz, 'fatal', 'Volume test', 'Error', false, 'production', '[]', '{}', '[]'
    FROM generate_series(1, 25005) AS n
  `;
  const user = await db.user.create({
    data: { id: randomUUID(), name: "Viewer", email: "viewer@example.test" },
  });
  const membership = await db.member.create({
    data: { id: randomUUID(), userId: user.id, organizationId, role: "viewer" },
  });
  const team = await db.team.create({
    data: { id: randomUUID(), organizationId, name: "Volume team" },
  });

  await db.teamMember.create({
    data: {
      id: randomUUID(),
      teamId: team.id,
      userId: user.id,
      memberId: membership.id,
    },
  });
  await db.projectTeam.create({
    data: { projectId: project.id, teamId: team.id },
  });
  const viewer = { id: membership.id, role: "viewer", organizationId };
  const filters = activityFilters({ project: project.id, period: "24h" });
  const activity = await eventActivity(web, viewer, filters, window);
  const overview = await overviewData(web, viewer, filters, window);
  const breakdown = await eventBreakdowns(web, viewer, filters, window);

  expect(activity).toMatchObject({
    total: 25002,
    unhandled: 25002,
    fatal: 25002,
    mapped: 0,
  });
  expect(activity.buckets[0]?.count).toBe(1);
  expect(activity.buckets[23]?.count).toBe(25001);
  expect(overview.health[0]?.events).toBe(25002);
  expect(overview.topIssues[0]?.matchingEvents).toBe(25002);
  expect(overview.projects.map((row) => row.id)).toEqual([project.id]);
  expect(breakdown).toEqual({
    browsers: [{ label: null, count: 25002 }],
    releases: [{ label: null, releaseId: null, count: 25002 }],
  });

  await db.member.update({
    where: { id: membership.id },
    data: { active: false },
  });
  expect((await eventActivity(web, viewer, filters, window)).total).toBe(0);
  expect((await overviewData(web, viewer, filters, window)).health).toEqual([]);
  await db.project.update({
    where: { id: project.id },
    data: { deletedAt: now, enabled: false },
  });
  const owner = { id: "owner", role: "owner", organizationId };

  expect((await eventActivity(web, owner, filters, window)).total).toBe(0);
  expect(await eventBreakdowns(web, owner, filters, window)).toEqual({
    browsers: [],
    releases: [],
  });
  expect((await overviewData(web, owner, filters, window)).health).toEqual([]);
});
