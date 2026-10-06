import Link from "next/link";
import { dateTime, releaseLabel } from "../../lib/format";
import { linkTo } from "../../lib/search-params";
import type { ActivityFilters } from "../../lib/activity";
import { ReleaseContext } from "../releases/ReleaseContext";
import type { DeploymentSummary } from "../releases/presentation";
import { Empty } from "../dashboard/Empty";

export function RecentReleases({
  releases,
  filters,
}: {
  releases: {
    id: string;
    projectId: string;
    name: string;
    appVersion?: string | null;
    project: { name: string };
    latest: Date;
    deployments: DeploymentSummary[];
  }[];
  filters: ActivityFilters;
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Active releases</h2>
          <p className="muted">Builds reporting events in this view</p>
        </div>
        <Link
          className="text-link"
          href={linkTo("/releases", {
            project: filters.project,
            environment: filters.environment,
          })}
        >
          All releases ↗
        </Link>
      </div>
      {releases.length ? (
        releases.map((release) => (
          <div className="release-row" key={release.id}>
            <span className="release-mark" aria-hidden="true">
              ◇
            </span>
            <div className="grow">
              <Link
                className="text-link mono"
                title={release.name}
                href={linkTo(`/releases/${release.id}`, {
                  environment: filters.environment,
                })}
              >
                {releaseLabel(release.name, release.appVersion)} ↗
              </Link>
              <small className="muted">
                {release.project.name} · {dateTime(release.latest)}
              </small>
              <ReleaseContext
                projectId={release.projectId}
                deployments={release.deployments}
              />
            </div>
          </div>
        ))
      ) : (
        <Empty title="No release events in this view">
          Choose another period or include a release when initializing the SDK.
        </Empty>
      )}
    </section>
  );
}
