import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import IssuesPage from "../../apps/web/src/app/(dashboard)/issues/page";
import IssuePage from "../../apps/web/src/app/(dashboard)/issues/[id]/page";

const { db, latestIssueEvents, eventActivity, eventBreakdowns } = vi.hoisted(
  () => ({
    db: {
      project: { findMany: vi.fn() },
      issue: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
      issueActivity: { findMany: vi.fn() },
      errorEvent: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
      release: { findMany: vi.fn(), findUnique: vi.fn() },
    },
    latestIssueEvents: vi.fn(),
    eventActivity: vi.fn(),
    eventBreakdowns: vi.fn(),
  }),
);

vi.mock("../../apps/web/src/server/runtime", () => ({
  getRuntime: () => ({ db }),
}));
vi.mock("../../apps/web/src/server/dashboard", () => ({
  dashboardUser: async () => ({
    member: { id: "viewer", role: "viewer", organizationId: "workspace" },
  }),
}));
vi.mock("../../apps/web/src/server/issues/insights", () => ({
  latestIssueEvents,
}));
vi.mock("../../apps/web/src/server/analytics/activity", () => ({
  eventActivity,
  eventBreakdowns,
}));

const date = new Date("2026-09-21T17:00:00Z");
const releaseName = `account@${"a".repeat(40)}`;
const release = {
  id: "release",
  projectId: "account",
  name: releaseName,
  deployments: [
    {
      environment: "staging",
      reviewKey: "gitlab:7:554",
      registeredAt: date,
    },
  ],
};
const issue = {
  id: "issue",
  projectId: "account",
  project: { name: "account" },
  exceptionType: "TypeError",
  title: "Cannot read properties of undefined",
  status: "open",
  regression: false,
  eventCount: 2,
  firstSeen: date,
  lastSeen: date,
};
const selected = {
  id: "stored-event",
  eventId: "a".repeat(32),
  receivedAt: date,
  environment: "staging",
  release: releaseName,
  level: "error",
  handled: true,
  frames: [],
  originalFrames: [],
  breadcrumbs: [],
  tags: {},
  symbolicationState: "missing",
};

beforeEach(() => {
  vi.clearAllMocks();
  db.project.findMany.mockResolvedValue([{ id: "account", name: "account" }]);
  db.issue.findMany.mockResolvedValue([issue]);
  db.issue.findFirst.mockResolvedValue(issue);
  db.issue.count.mockResolvedValue(1);
  db.issueActivity.findMany.mockResolvedValue([]);
  db.errorEvent.findMany.mockResolvedValue([selected]);
  db.errorEvent.findFirst
    .mockResolvedValueOnce(selected)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null);
  db.errorEvent.count.mockResolvedValue(1);
  db.release.findMany.mockResolvedValue([release]);
  db.release.findUnique.mockResolvedValue(release);
  latestIssueEvents.mockResolvedValue([
    {
      issueId: issue.id,
      eventId: selected.eventId,
      environment: "staging",
      release: releaseName,
      receivedAt: date,
      symbolicationState: "missing",
    },
  ]);
  eventActivity.mockResolvedValue({
    buckets: [],
    total: 0,
    unhandled: 0,
    mapped: 0,
    fatal: 0,
  });
  eventBreakdowns.mockResolvedValue({ browsers: [], releases: [] });
});

it("shows compact build context below the issue title and opens the retained event", async () => {
  const html = renderToStaticMarkup(
    await IssuesPage({ searchParams: Promise.resolve({}) }),
  );
  const issueCell = html.match(
    /<td><div class="issue-cell">([\s\S]*?)<\/div><\/td>/,
  )?.[1];

  expect(html).not.toContain("<th>Latest retained event</th>");
  expect(issueCell).toContain("Preview / staging");
  expect(issueCell).toContain("MR !554");
  expect(issueCell).toContain("Compiled stack");
  expect(issueCell?.indexOf(issue.title)).toBeLessThan(
    issueCell?.indexOf("Preview / staging") ?? 0,
  );
  expect(html).toContain("Has source context");
  expect(html).toContain(`/issues/issue?event=${selected.eventId}`);
  expect(latestIssueEvents).toHaveBeenCalledWith(
    db,
    [issue.id],
    expect.objectContaining({ environment: "all" }),
  );
});

it("shows the missing retained event note below the issue title", async () => {
  latestIssueEvents.mockResolvedValueOnce([]);
  const html = renderToStaticMarkup(
    await IssuesPage({ searchParams: Promise.resolve({}) }),
  );

  expect(html).toContain(
    '<span class="muted issue-no-event">No retained event</span>',
  );
  expect(html).not.toContain("issue-build-context");
});

it("sorts the issue query before pagination and replaces the Sort dropdown with accessible headers", async () => {
  const html = renderToStaticMarkup(
    await IssuesPage({
      searchParams: Promise.resolve({
        sort: "events",
        direction: "asc",
        page: "2",
        environment: "staging",
      }),
    }),
  );

  expect(db.issue.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      orderBy: [{ eventCount: "asc" }, { id: "asc" }],
      skip: 25,
      take: 25,
    }),
  );
  expect(html).not.toContain('aria-label="Sort"');
  expect(html).toContain('aria-sort="ascending"');
  expect(html).toContain('name="sort" value="events"');
  expect(html).toContain('name="direction" value="asc"');
});

it("sorts the event table without changing the selected event or chronological navigation", async () => {
  await IssuePage({
    params: Promise.resolve({ id: issue.id }),
    searchParams: Promise.resolve({
      event: selected.eventId,
      sort: "release",
      direction: "asc",
      page: "2",
    }),
  });

  expect(db.errorEvent.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      orderBy: [{ release: { sort: "asc", nulls: "last" } }, { id: "asc" }],
      skip: 20,
      take: 20,
    }),
  );
  expect(db.errorEvent.findFirst).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      where: {
        projectId: issue.projectId,
        issueId: issue.id,
        eventId: selected.eventId,
      },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    }),
  );
});

it("shows selected-event MR build context and recent activity on the issue", async () => {
  const html = renderToStaticMarkup(
    await IssuePage({
      params: Promise.resolve({ id: issue.id }),
      searchParams: Promise.resolve({ event: selected.eventId }),
    }),
  );

  expect(html).toContain("MR !554");
  expect(html).toContain("Issue activity");
  expect(html).toContain("Last 7 days");
  expect(html).toContain("Browsers and releases");
  expect(html).toContain(selected.eventId);
  expect(db.release.findUnique).toHaveBeenCalledWith(
    expect.objectContaining({ select: { id: true, deployments: true } }),
  );
});
