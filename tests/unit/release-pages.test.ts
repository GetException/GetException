import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ReleasesPage from "../../apps/web/src/app/(dashboard)/releases/page";
import ReleasePage from "../../apps/web/src/app/(dashboard)/releases/[id]/page";

const { db } = vi.hoisted(() => ({
  db: {
    release: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    project: { findMany: vi.fn() },
    errorEvent: { groupBy: vi.fn(), aggregate: vi.fn(), count: vi.fn() },
    issue: { count: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("../../apps/web/src/server/runtime", () => ({
  getRuntime: () => ({ db }),
}));
vi.mock("../../apps/web/src/server/dashboard", () => ({
  dashboardUser: async () => ({
    member: { id: "viewer", role: "viewer", organizationId: "workspace" },
  }),
}));
const date = new Date("2026-09-17T12:00:00Z");
const releases = [
  {
    id: "first",
    projectId: "account",
    name: `account@${"a".repeat(40)}`,
    project: { name: "account" },
    sourceMapsState: "ready",
    createdAt: date,
    deployments: [
      { environment: "production", reviewKey: "", registeredAt: date },
    ],
  },
  {
    id: "second",
    projectId: "account",
    name: `account@${"b".repeat(40)}`,
    project: { name: "account" },
    sourceMapsState: "missing",
    createdAt: date,
    deployments: [
      { environment: "staging", reviewKey: "gitlab:12:34", registeredAt: date },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  db.release.findMany.mockResolvedValue(releases);
  db.release.findFirst.mockResolvedValue(releases[1]);
  db.release.count.mockResolvedValue(2);
  db.project.findMany.mockResolvedValue([{ id: "account", name: "account" }]);
  db.errorEvent.groupBy.mockResolvedValue(
    releases.map((release) => ({
      projectId: release.projectId,
      release: release.name,
      _count: { _all: 2 },
      _max: { receivedAt: date },
    })),
  );
  db.errorEvent.aggregate.mockResolvedValue({
    _count: { _all: 2 },
    _min: { receivedAt: date },
    _max: { receivedAt: date },
  });
  db.errorEvent.count.mockResolvedValue(1);
  db.issue.count.mockResolvedValue(1);
  db.issue.findMany.mockResolvedValue([]);
});

function preview(name: string, html: string) {
  const directory = process.env.RELEASE_PREVIEW_DIR;

  if (!directory) {
    return;
  }

  mkdirSync(directory, { recursive: true });
  const css = readFileSync("apps/web/src/app/globals.css", "utf8");

  writeFileSync(
    join(directory, `${name}.html`),
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main style="max-width:1440px;margin:32px auto;padding:0 24px">${html}</main></body></html>`,
  );
}

it("renders readable release identity, environments and source map status", async () => {
  const html = renderToStaticMarkup(
    await ReleasesPage({ searchParams: Promise.resolve({}) }),
  );

  expect(html).toContain("Production");
  expect(html).toContain("Preview / staging");
  expect(html).toContain("MR !34");
  expect(html).toContain("Not uploaded");
  preview("releases", html);
});

it("scopes counts and issue links to the selected environment while retaining release context", async () => {
  db.issue.findMany.mockResolvedValue([
    {
      id: "issue",
      exceptionType: "Error",
      title: "Preview error",
      status: "open",
      regression: false,
      _count: { events: 2 },
      events: [{ eventId: "preview-event" }],
    },
  ]);
  const html = renderToStaticMarkup(
    await ReleasePage({
      params: Promise.resolve({ id: "second" }),
      searchParams: Promise.resolve({ environment: "staging" }),
    }),
  );

  expect(db.release.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        project: expect.objectContaining({ organizationId: "workspace" }),
      }),
    }),
  );
  expect(db.errorEvent.aggregate).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        projectId: "account",
        release: releases[1]!.name,
        environment: "staging",
      },
    }),
  );
  expect(db.issue.count).toHaveBeenCalledWith({
    where: {
      projectId: "account",
      events: { some: { release: releases[1]!.name, environment: "staging" } },
    },
  });
  expect(html).toContain("environment=staging");
  expect(html).toContain("MR !34");
  expect(html).toContain("/issues/issue?event=preview-event");
  expect(html).toContain("Release created");
  expect(html).not.toContain("Environments</span><strong>1");
  preview("release", html);
});

it("groups preview builds by repository and MR, with a link to all builds", async () => {
  db.release.findMany.mockResolvedValue([
    releases[1],
    { ...releases[1], id: "third", name: `account@${"c".repeat(40)}` },
  ]);
  const html = renderToStaticMarkup(
    await ReleasesPage({
      searchParams: Promise.resolve({ environment: "staging" }),
    }),
  );

  expect(html.match(/scope="rowgroup"/g)).toHaveLength(1);
  expect(html).toContain("View all builds");
  expect(html).toContain("review=gitlab%3A12%3A34");
  expect(db.errorEvent.groupBy).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ environment: "staging" }),
    }),
  );
});
