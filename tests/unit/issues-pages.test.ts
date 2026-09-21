import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import IssuesPage from "../../apps/web/src/app/(dashboard)/issues/page";
import IssuePage from "../../apps/web/src/app/(dashboard)/issues/[id]/page";

const { db, latestIssueEvents, issueTrend } = vi.hoisted(() => ({
  db: {
    project: { findMany: vi.fn() },
    issue: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    issueActivity: { findMany: vi.fn() },
    errorEvent: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    release: { findMany: vi.fn(), findUnique: vi.fn() },
  },
  latestIssueEvents: vi.fn(),
  issueTrend: vi.fn(),
}));

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
  issueTrend,
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
    },
  ]);
  issueTrend.mockResolvedValue([{ date: "2026-09-21", count: 2 }]);
});

it("shows the latest retained build and opens that event from the Issues list", async () => {
  const html = renderToStaticMarkup(
    await IssuesPage({ searchParams: Promise.resolve({}) }),
  );

  expect(html).toContain("Latest retained event");
  expect(html).toContain("Preview / staging");
  expect(html).toContain("MR !554");
  expect(html).toContain(`/issues/issue?event=${selected.eventId}`);
  expect(latestIssueEvents).toHaveBeenCalledWith(
    db,
    [issue.id],
    expect.objectContaining({ environment: "all" }),
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
  expect(html).toContain("Recent activity");
  expect(html).toContain(
    "Retained events · all environments · UTC · last 7 days",
  );
  expect(html).toContain(selected.eventId);
  expect(db.release.findUnique).toHaveBeenCalledWith(
    expect.objectContaining({ select: { id: true, deployments: true } }),
  );
});
