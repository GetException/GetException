import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Database } from "@getexception/db";
import { IssueBuildContext } from "../../apps/web/src/components/issues/IssueBuildContext";
import { IssueTrend } from "../../apps/web/src/components/issues/IssueTrend";
import {
  issueTrend,
  latestIssueEvents,
} from "../../apps/web/src/server/issues/insights";

const release = {
  id: "release",
  deployments: [
    { environment: "production", reviewKey: "", registeredAt: null },
    {
      environment: "staging",
      reviewKey: "gitlab:7:554",
      registeredAt: null,
    },
  ],
};

it("shows MR build context for preview without mislabeling production", () => {
  const props = {
    projectId: "account",
    releaseName: `account@${"a".repeat(40)}`,
    release,
  };
  const preview = renderToStaticMarkup(
    createElement(IssueBuildContext, {
      ...props,
      environment: "staging",
    }),
  );
  const production = renderToStaticMarkup(
    createElement(IssueBuildContext, {
      ...props,
      environment: "production",
    }),
  );

  expect(preview).toContain("Preview / staging");
  expect(preview).toContain("MR !554");
  expect(preview).toContain("review=gitlab%3A7%3A554");
  expect(preview).toContain("event does not contain a preview identifier");
  expect(production).toContain("Production");
  expect(production).not.toContain("MR !554");
});

it("discloses when a build belongs to more than one MR", () => {
  const html = renderToStaticMarkup(
    createElement(IssueBuildContext, {
      projectId: "account",
      environment: "staging",
      releaseName: `account@${"a".repeat(40)}`,
      release: {
        ...release,
        deployments: [
          ...release.deployments,
          {
            environment: "staging",
            reviewKey: "gitlab:7:555",
            registeredAt: null,
          },
        ],
      },
    }),
  );

  expect(html).toContain("MR !554");
  expect(html).toContain("MR !555");
  expect(html).toContain("Build used in several MRs");
});

it("fills missing UTC days and renders a readable event trend", async () => {
  const query = vi.fn().mockResolvedValue([
    { date: "2026-09-19", count: 4 },
    { date: "2026-09-21", count: 2 },
  ]);
  const db = { $queryRaw: query } as unknown as Database;
  const days = await issueTrend(
    db,
    "account",
    "issue",
    new Date("2026-09-21T20:00:00Z"),
  );

  expect(days).toHaveLength(7);
  expect(days[0]).toEqual({ date: "2026-09-15", count: 0 });
  expect(days[4]).toEqual({ date: "2026-09-19", count: 4 });
  expect(days[6]).toEqual({ date: "2026-09-21", count: 2 });
  const html = renderToStaticMarkup(createElement(IssueTrend, { days }));

  expect(html).toContain("Recent activity");
  expect(html).toContain("2026-09-19: 4 events");
  expect(html).toContain("events in 7 days");
});

it("limits latest-event lookup to visible issue IDs and selected filters", async () => {
  const query = vi.fn().mockResolvedValue([]);
  const db = { $queryRaw: query } as unknown as Database;

  expect(
    await latestIssueEvents(db, [], {
      environment: "all",
      release: "",
    }),
  ).toEqual([]);
  expect(query).not.toHaveBeenCalled();
  await latestIssueEvents(db, ["visible"], {
    environment: "staging",
    release: "account@sha",
  });
  const statement = query.mock.calls[0]![0];

  expect(statement.sql).toContain('"issueId" IN');
  expect(statement.values).toEqual(["visible", "staging", "account@sha"]);
});
