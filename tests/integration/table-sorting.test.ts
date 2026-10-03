import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase } from "@getexception/db";
import { temporaryDatabase } from "./database";
import {
  tableColumns,
  tableSort,
  type TableSort,
} from "../../apps/web/src/lib/table-sort";
import {
  projectPageIds,
  ingestionKeyPageIds,
} from "../../apps/web/src/server/projects/list";
import {
  releasePageIds,
  releaseIssuePageIds,
} from "../../apps/web/src/server/releases/list";
import {
  memberPageIds,
  invitationPageIds,
} from "../../apps/web/src/server/members/list";
import { auditPageIds } from "../../apps/web/src/server/audit/list";
import {
  issueOrder,
  eventOrder,
} from "../../apps/web/src/server/issues/sorting";
import { projectScope } from "../../apps/web/src/server/access";
import {
  releaseFilters,
  releaseWhere,
} from "../../apps/web/src/server/releases/filters";
import { issueFilters, issueWhere } from "../../apps/web/src/server/filters";

let instance: Awaited<ReturnType<typeof temporaryDatabase>>;
let web: ReturnType<typeof createDatabase>;
const owner = { id: "m00", organizationId: "workspace", role: "owner" };
const viewer = { id: "m03", organizationId: "workspace", role: "viewer" };
const now = new Date("2026-10-03T12:00:00Z");
const name = (prefix: string, index: number) =>
  `${prefix}${String(index).padStart(2, "0")}`;
const day = (index: number) => new Date(now.getTime() + index * 86400_000);
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
const asc = (sort: string): TableSort => ({ sort, direction: "asc" });
const desc = (sort: string): TableSort => ({ sort, direction: "desc" });

beforeAll(async () => {
  instance = await temporaryDatabase();
  web = createDatabase(instance.urls.web);
  const db = instance.admin;

  await db.organization.createMany({
    data: [{ id: "workspace", name: "Workspace", slug: "workspace" }],
  });
  await db.user.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      id: name("u", i),
      name: name("User ", i),
      email: `${name("user", i)}@example.test`,
      disabled: i === 1,
      twoFactorEnabled: i % 2 === 0,
    })),
  });
  await db.member.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      id: name("m", i),
      userId: name("u", i),
      organizationId: "workspace",
      role: i === 0 ? "owner" : i === 1 ? "developer" : "viewer",
      active: i !== 2,
      createdAt: day(i),
    })),
  });
  await db.project.createMany({
    data: [
      ...Array.from({ length: 30 }, (_, i) => ({
        id: name("p", i),
        organizationId: "workspace",
        name: name("Project ", i),
        slug: name("project-", i),
        enabled: i % 2 === 0,
        createdAt: day(i),
      })),
      {
        id: "deleted",
        organizationId: "workspace",
        name: "Deleted",
        slug: "deleted",
        enabled: false,
        deletedAt: now,
      },
    ],
  });
  await db.team.createMany({
    data: [
      { id: "a", organizationId: "workspace", name: "Alpha" },
      { id: "z", organizationId: "workspace", name: "Zulu" },
    ],
  });
  await db.teamMember.createMany({
    data: [
      { id: "tm03", memberId: "m03", userId: "u03", teamId: "a" },
      { id: "tm02", memberId: "m02", userId: "u02", teamId: "a" },
      { id: "tm04", memberId: "m04", userId: "u04", teamId: "z" },
    ],
  });
  await db.projectTeam.createMany({
    data: [
      { projectId: "p29", teamId: "a" },
      { projectId: "p28", teamId: "z" },
      { projectId: "deleted", teamId: "a" },
    ],
  });
  await db.issue.createMany({
    data: Array.from({ length: 30 }, (_, p) =>
      Array.from({ length: p }, (_, i) => ({
        id: `${name("p", p)}-${name("i", i)}`,
        projectId: name("p", p),
        fingerprint: String(i),
        title: name("Error ", i),
        exceptionType: "Error",
        eventCount: 1,
        firstSeen: day(i),
        lastSeen: day(i),
      })),
    ).flat(),
  });
  await db.issue.createMany({
    data: Array.from({ length: 35 }, (_, i) => ({
      id: name("closed", i),
      projectId: "p00",
      fingerprint: String(i),
      title: "Not an open issue",
      exceptionType: "Error",
      status: i % 2 ? "resolved" : "open",
      eventCount: i % 2 ? 100 : 0,
      firstSeen: now,
      lastSeen: now,
    })),
  });
  await db.release.createMany({
    data: [
      ...Array.from({ length: 28 }, (_, i) => ({
        id: name("r", i),
        projectId: "p29",
        name: name("account@", i),
        createdAt: day(28 - i),
        sourceMapsState: i === 0 ? "missing" : "ready",
        sourceMapsVersion: i === 0 ? 1 : 0,
      })),
      { id: "empty", projectId: "p29", name: "account@empty" },
      { id: "hidden", projectId: "p28", name: "hidden" },
      { id: "deleted-release", projectId: "deleted", name: "deleted" },
    ],
  });
  await db.releaseDeployment.createMany({
    data: [
      ...Array.from({ length: 28 }, (_, i) => ({
        id: name("d", i),
        releaseId: name("r", i),
        environment: "staging",
        reviewKey: `gitlab:7:${i + 1}`,
      })),
      { id: "production", releaseId: "r00", environment: "production" },
    ],
  });
  const events = Array.from({ length: 28 }, (_, r) =>
    Array.from({ length: r + 1 }, (_, i) => ({
      id: `e${r}-${i}`,
      eventId: `${r}-${i}`.padStart(32, "0"),
      projectId: "p29",
      issueId: `p29-${name("i", r)}`,
      release: name("account@", r),
      environment: "staging",
      receivedAt: day(r),
      timestamp: day(r),
      level: "error",
      handled: r % 2 === 0,
      message: "Error",
      exceptionType: "Error",
      frames: [],
      breadcrumbs: [],
      tags: {},
    })),
  ).flat();

  await db.errorEvent.createMany({
    data: [
      ...events,
      ...Array.from({ length: 50 }, (_, i) => ({
        ...events[0]!,
        id: `prod${i}`,
        eventId: `prod${i}`.padStart(32, "0"),
        environment: "production",
        receivedAt: day(50),
      })),
    ],
  });
  await db.errorEvent.update({
    where: { id: "e27-0" },
    data: { release: "account@00" },
  });
  await db.invitation.createMany({
    data: ["pending", "pending", "accepted", "revoked"].map((status, i) => ({
      id: name("inv", i),
      organizationId: "workspace",
      inviterId: "u00",
      email: `person${i}@example.test`,
      role: "viewer",
      status,
      expiresAt: day(i === 0 ? -1 : 1),
    })),
  });
  await db.projectIngestionKey.createMany({
    data: [
      {
        id: "active",
        projectId: "p29",
        keyHash: "active-test-hash",
        expiresAt: day(2),
      },
      { id: "permanent", projectId: "p29", keyHash: "permanent-test-hash" },
      {
        id: "expired",
        projectId: "p29",
        keyHash: "expired-test-hash",
        expiresAt: day(-2),
      },
      {
        id: "revoked",
        projectId: "p29",
        keyHash: "revoked-test-hash",
        revokedAt: now,
        expiresAt: day(-1),
      },
    ],
  });
  await db.auditLog.createMany({
    data: [
      {
        id: "a1",
        action: "setup_activate",
        actorId: "u00",
        success: true,
        createdAt: day(1),
      },
      {
        id: "a2",
        action: "totp",
        actorId: "u01",
        success: false,
        createdAt: day(2),
      },
      {
        id: "a3",
        action: "password",
        actorId: "removed",
        success: false,
        createdAt: day(3),
      },
      { id: "a4", action: "password", success: false, createdAt: day(4) },
    ],
  });
});

afterAll(async () => {
  await web?.$disconnect();
  await instance?.cleanup();
});

it("sorts project aggregates across pages and keeps authorized scope", async () => {
  const first = ids(await projectPageIds(web, owner, "", desc("issues"), 1));
  const second = ids(await projectPageIds(web, owner, "", desc("issues"), 2));

  expect([...first, ...second]).toEqual(
    Array.from({ length: 30 }, (_, i) => name("p", 29 - i)),
  );
  expect(ids(await projectPageIds(web, viewer, "", desc("issues"), 1))).toEqual(
    ["p29"],
  );
  expect(
    await projectPageIds(web, { ...viewer, id: "m02" }, "", desc("events"), 1),
  ).toEqual([]);
  expect(
    await projectPageIds(
      web,
      { ...owner, organizationId: "foreign" },
      "",
      desc("events"),
      1,
    ),
  ).toEqual([]);
  expect(
    ids(await projectPageIds(web, owner, "Project 2", asc("project"), 1)),
  ).toEqual(Array.from({ length: 10 }, (_, i) => name("p", 20 + i)));
  expect(
    ids(await projectPageIds(web, owner, "", asc("teams"), 1)).slice(0, 2),
  ).toEqual(["p29", "p28"]);
  expect(
    await projectPageIds(web, owner, "' OR true --", desc("events"), 1),
  ).toEqual([]);
});

it("sorts retained release counts and latest events in the selected environment, before pagination", async () => {
  const query = (
    page: string,
    sort = "events",
    direction = "desc",
    environment = "staging",
  ) =>
    releasePageIds(
      web,
      viewer,
      releaseFilters({ page, sort, direction, environment }),
    );
  const ordered = [...ids(await query("1")), ...ids(await query("2"))];

  // r27 has 27 events after one moved to r00; ties use the release id.
  expect(ordered.slice(0, 3)).toEqual(["r27", "r26", "r25"]);
  expect(ordered).toHaveLength(28);
  expect(new Set(ordered).size).toBe(28);
  expect(ids(await query("1", "events", "desc", "all"))[0]).toBe("r00");
  expect(ids(await query("1", "latest"))[0]).toBe("r27");
  expect(ids(await query("1", "latest", "desc", "all"))[0]).toBe("r00");
  expect(ids(await query("1", "review", "asc")).slice(0, 3)).toEqual([
    "r00",
    "r01",
    "r02",
  ]);
  const allAscending = [
    ...ids(await query("1", "latest", "asc", "all")),
    ...ids(await query("2", "latest", "asc", "all")),
  ];

  expect(allAscending.at(-1)).toBe("empty");
});

it("uses the same release filters in sorted SQL and Prisma, without crossing project or environment boundaries", async () => {
  for (const search of [
    {},
    { environment: "production" },
    { environment: "staging", review: "gitlab:7:12" },
    { maps: "removed" },
    { maps: "missing" },
    { maps: "unavailable" },
    { maps: "ready", q: "account@0" },
    { project: "foreign" },
    { project: "deleted" },
    { environment: "production", review: "gitlab:7:2" },
  ]) {
    const filters = releaseFilters(search);
    const actual = [
      ...ids(await releasePageIds(web, viewer, filters)),
      ...ids(await releasePageIds(web, viewer, { ...filters, page: 2 })),
    ];
    const expected = ids(
      await web.release.findMany({
        where: releaseWhere(viewer, filters),
        select: { id: true },
      }),
    );

    expect(actual.sort()).toEqual(expected.sort());
  }
});

it("sorts release issues using scoped counts, not lifetime totals", async () => {
  expect(
    ids(
      await releaseIssuePageIds(
        web,
        "p29",
        "account@00",
        "staging",
        desc("events"),
        1,
      ),
    ),
  ).toEqual(["p29-i27", "p29-i00"]);
  expect(
    ids(
      await releaseIssuePageIds(
        web,
        "p29",
        "account@00",
        "all",
        desc("events"),
        1,
      ),
    ),
  ).toEqual(["p29-i00", "p29-i27"]);
});

it("orders member status using both account and membership state, with owner-only access", async () => {
  expect(
    ids(await memberPageIds(web, owner, "", desc("status"), 1)).slice(0, 2),
  ).toEqual(["m02", "m01"]);
  expect(
    ids(await memberPageIds(web, owner, "User 2", asc("member"), 1)),
  ).toEqual(Array.from({ length: 10 }, (_, i) => name("m", 20 + i)));
  expect(
    ids(await memberPageIds(web, owner, "", asc("teams"), 1)).slice(0, 3),
  ).toEqual(["m02", "m03", "m04"]);
  expect(() => memberPageIds(web, viewer, "", asc("member"), 1)).toThrow();
  expect(() => invitationPageIds(web, viewer, asc("email"), 1, now)).toThrow();
  expect(() => auditPageIds(web, viewer, "", "", asc("time"), 1)).toThrow();
});

it("sorts derived invitation and key states, with missing expiry dates last", async () => {
  expect(
    ids(await invitationPageIds(web, owner, asc("status"), 1, now)),
  ).toEqual(["inv02", "inv00", "inv01", "inv03"]);
  expect(
    ids(await ingestionKeyPageIds(web, "p29", asc("status"), 1, now)),
  ).toEqual(["active", "permanent", "expired", "revoked"]);
  expect(
    ids(await ingestionKeyPageIds(web, "p29", asc("expires"), 1, now)),
  ).toEqual(["expired", "revoked", "active", "permanent"]);
  expect(
    ids(await ingestionKeyPageIds(web, "p29", desc("expires"), 1, now)),
  ).toEqual(["active", "revoked", "expired", "permanent"]);
});

it("sorts audit actors and human-readable actions, preserving filters", async () => {
  expect(ids(await auditPageIds(web, owner, "", "", asc("actor"), 1))).toEqual([
    "a3",
    "a4",
    "a1",
    "a2",
  ]);
  expect(ids(await auditPageIds(web, owner, "", "", asc("action"), 1))).toEqual(
    ["a2", "a1", "a3", "a4"],
  );
  expect(
    ids(await auditPageIds(web, owner, "password", "failure", desc("time"), 1)),
  ).toEqual(["a4", "a3"]);
});

it("executes every sortable column in both directions with the restricted web DB role", async () => {
  for (const direction of ["asc", "desc"] as const) {
    for (const { key } of tableColumns.projects) {
      expect(
        await projectPageIds(web, viewer, "", { sort: key, direction }, 1),
      ).toHaveLength(1);
    }

    for (const { key } of tableColumns.releases) {
      expect(
        await releasePageIds(
          web,
          viewer,
          releaseFilters({ sort: key, direction }),
        ),
      ).toHaveLength(25);
    }

    for (const { key } of tableColumns.members) {
      expect(
        await memberPageIds(web, owner, "", { sort: key, direction }, 1),
      ).toHaveLength(25);
    }

    for (const { key } of tableColumns.invitations) {
      expect(
        await invitationPageIds(web, owner, { sort: key, direction }, 1, now),
      ).toHaveLength(4);
    }

    for (const { key } of tableColumns.audit) {
      expect(
        await auditPageIds(web, owner, "", "", { sort: key, direction }, 1),
      ).toHaveLength(4);
    }

    for (const { key } of tableColumns.releaseIssues) {
      expect(
        await releaseIssuePageIds(
          web,
          "p29",
          "account@00",
          "all",
          { sort: key, direction },
          1,
        ),
      ).toHaveLength(2);
    }

    for (const { key } of tableColumns.keys) {
      expect(
        await ingestionKeyPageIds(web, "p29", { sort: key, direction }, 1, now),
      ).toHaveLength(4);
    }

    for (const { key } of tableColumns.issues) {
      const rows = await web.issue.findMany({
        where: issueWhere(viewer, issueFilters({})),
        orderBy: issueOrder(tableSort({ sort: key, direction }, "issues")),
        take: 25,
      });

      expect(rows).toHaveLength(25);
      expect(rows.every((row) => row.projectId === "p29")).toBe(true);
    }

    for (const { key } of tableColumns.events) {
      expect(
        await web.errorEvent.findMany({
          where: { project: projectScope(viewer) },
          orderBy: eventOrder(tableSort({ sort: key, direction }, "events")),
          take: 20,
        }),
      ).toHaveLength(20);
    }
  }
});
