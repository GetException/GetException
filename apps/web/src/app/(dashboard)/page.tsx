import Link from "next/link";
import { getRuntime } from "../../server/runtime";
import { dashboardUser } from "../../server/dashboard";
import { Heading } from "../../components/dashboard/Heading";
import { Stat } from "../../components/dashboard/Stat";
import { ActivityFilters } from "../../components/analytics/ActivityFilters";
import { ActivityChart } from "../../components/analytics/ActivityChart";
import { TopIssues } from "../../components/overview/TopIssues";
import { ProjectHealth } from "../../components/overview/ProjectHealth";
import { RecentReleases } from "../../components/overview/RecentReleases";
import { eventActivity } from "../../server/analytics/activity";
import { overviewData } from "../../server/analytics/overview";
import {
  activityFilters,
  activityWindow,
  ACTIVITY_PERIODS,
  percentage,
} from "../../lib/activity";
import { linkTo, type Search } from "../../lib/search-params";

export default async function Overview({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const { member } = await dashboardUser();
  const { db } = getRuntime();
  const filters = activityFilters(await searchParams);
  const window = activityWindow(filters.period);
  const [activity, overview] = await Promise.all([
    eventActivity(db, member, filters, window),
    overviewData(db, member, filters, window),
  ]);

  return (
    <div className="page">
      <Heading
        title="Overview"
        description="Error activity and issues that need attention."
        action={
          <Link href={linkTo("/issues", filters)} className="button primary">
            Explore issues ↗
          </Link>
        }
      />
      <section className="panel">
        <ActivityFilters filters={filters} projects={overview.projects} />
      </section>
      <div className="stats-grid">
        <Stat
          label="Events"
          value={activity.total}
          caption={`${ACTIVITY_PERIODS[filters.period].label} · selected environment and projects`}
        />
        <Stat
          label="Active open issues"
          value={overview.open}
          caption="Open issues with events in this view"
          href={linkTo("/issues", { ...filters, status: "open" })}
        />
        <Stat
          label="Active regressions"
          value={overview.regressions}
          caption="Reopened issues with events in this view"
          href={linkTo("/issues", { ...filters, status: "regression" })}
        />
        <Stat
          label="Unhandled events"
          value={activity.unhandled}
          caption={`${percentage(activity.unhandled, activity.total)} of events in this view`}
        />
      </div>
      <ActivityChart
        key={JSON.stringify(filters)}
        data={activity}
        period={filters.period}
      />
      <TopIssues issues={overview.topIssues} filters={filters} />
      <div className="overview-columns">
        <ProjectHealth projects={overview.health} filters={filters} />
        <RecentReleases releases={overview.releases} filters={filters} />
      </div>
    </div>
  );
}
