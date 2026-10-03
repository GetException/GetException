import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  activityFilters,
  activityWindow,
  activityDateRange,
  percentage,
} from "../../apps/web/src/lib/activity";
import { activityData } from "../../apps/web/src/server/analytics/activity";
import { ActivityChart } from "../../apps/web/src/components/analytics/ActivityChart";
import { ActivityFilters } from "../../apps/web/src/components/analytics/ActivityFilters";
import { EventBreakdown } from "../../apps/web/src/components/analytics/EventBreakdown";
import { TopIssues } from "../../apps/web/src/components/overview/TopIssues";

const now = new Date("2026-10-03T12:30:00Z");

it("validates filter values and keeps issue activity filters independent", () => {
  expect(
    activityFilters({ period: "__proto__", environment: "constructor" }),
  ).toEqual({
    project: "",
    environment: "all",
    period: "24h",
  });
  expect(
    activityFilters({ period: ["30d"], environment: ["staging"] }),
  ).toEqual({
    project: "",
    environment: "all",
    period: "24h",
  });
  expect(
    activityFilters(
      {
        project: "account",
        period: "24h",
        activityPeriod: "30d",
        activityEnvironment: "staging",
      },
      "activity",
      "7d",
    ),
  ).toEqual({ project: "account", period: "30d", environment: "staging" });
  expect(activityDateRange("all", now)).toBeUndefined();
  expect(activityDateRange("24h", now)).toEqual({
    gte: new Date("2026-10-02T12:30:00Z"),
    lt: now,
  });
});

it("keeps empty intervals at zero and reconciles both chart splits with the total", () => {
  const data = activityData(
    [
      {
        bucket: 0,
        environment: "production",
        handled: false,
        count: 4,
        mapped: 3,
        fatal: 1,
      },
      {
        bucket: 0,
        environment: "staging",
        handled: true,
        count: 2,
        mapped: 1,
        fatal: 0,
      },
      {
        bucket: 6,
        environment: "development",
        handled: true,
        count: 3,
        mapped: 0,
        fatal: 0,
      },
    ],
    activityWindow("7d", now),
  );

  expect(data).toMatchObject({ total: 9, unhandled: 4, mapped: 4, fatal: 1 });
  expect(data.buckets).toHaveLength(7);
  expect(data.buckets[0]).toMatchObject({
    start: "2026-09-26T12:30:00.000Z",
    count: 6,
    production: 4,
    staging: 2,
  });
  expect(data.buckets[1]?.count).toBe(0);
  expect(data.buckets[6]?.end).toBe(now.toISOString());

  for (const bucket of data.buckets) {
    expect(bucket.production + bucket.staging + bucket.development).toBe(
      bucket.count,
    );
    expect(bucket.handled + bucket.unhandled).toBe(bucket.count);
  }

  const html = renderToStaticMarkup(<ActivityChart data={data} period="7d" />);

  expect(html).toContain("44%");
  expect(html).toContain("Production: 4");
  expect(html).toContain("UTC: 0 events");
  expect(html).toContain('height="0"');
  expect(html.match(/tabindex="0"/g)).toHaveLength(7);
});

it("shows empty activity without a fake bar or a success percentage", () => {
  const data = activityData([], activityWindow("24h", now));
  const html = renderToStaticMarkup(<ActivityChart data={data} period="24h" />);

  expect(html).toContain("No events in this view");
  expect(html).not.toContain("<svg");
  expect(percentage(0, 0)).toBe("—");
});

it("uses the entire filtered event count as the distribution denominator", () => {
  const html = renderToStaticMarkup(
    <EventBreakdown
      title="Browsers"
      caption="Last 7 days"
      total={10}
      rows={[
        { label: "Chrome 153", count: 6 },
        { label: "Not reported", count: 2 },
      ]}
    />,
  );

  expect(html).toContain("60%");
  expect(html).toContain("Other");
  expect(html.match(/20%/g)?.length).toBeGreaterThanOrEqual(2);
});

it("preserves the selected event and sorting while changing activity filters", () => {
  const html = renderToStaticMarkup(
    <ActivityFilters
      filters={{ project: "account", environment: "staging", period: "7d" }}
      prefix="activity"
      preserve={{ event: "chosen", sort: "release", direction: "asc", page: 2 }}
    />,
  );

  expect(html).toContain('name="event" value="chosen"');
  expect(html).toContain('name="sort" value="release"');
  expect(html).toContain('name="activityEnvironment"');
  expect(html).toContain('name="activityPeriod"');
  expect(html).not.toContain('name="project"');
});

it("opens a top issue at an event from the chosen view and preserves the chart filters", () => {
  const html = renderToStaticMarkup(
    <TopIssues
      filters={{ project: "account", environment: "staging", period: "30d" }}
      issues={[
        {
          id: "issue",
          title: "Failed",
          exceptionType: "Error",
          project: { name: "account" },
          matchingEvents: 3,
          latest: now,
          status: "open",
          regression: true,
          eventId: "preview-event",
        },
      ]}
    />,
  );
  const href = [...html.matchAll(/href="([^"]+)"/g)].find((match) =>
    match[1]!.startsWith("/issues/issue"),
  )![1]!;
  const url = new URL(
    href.replaceAll("&amp;", "&"),
    "https://monitor.example.test",
  );

  expect(Object.fromEntries(url.searchParams)).toEqual({
    event: "preview-event",
    activityPeriod: "30d",
    activityEnvironment: "staging",
  });
});
