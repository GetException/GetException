import Link from "next/link";
import { dateTime, releaseLabel } from "../../lib/format";
import { ENVIRONMENT_LABELS } from "../releases/presentation";

type Observation = {
  environment: string;
  firstSeen: Date;
  lastSeen: Date;
  firstRelease: string | null;
  lastRelease: string | null;
  firstAppVersion: string | null;
  lastAppVersion: string | null;
  firstSeenKnown: boolean;
};

export function IssueReleaseHistory({
  observations,
  releases,
}: {
  observations: Observation[];
  releases: { id: string; name: string; appVersion: string | null }[];
}) {
  return (
    <section className="issue-release-history">
      <h3>First and latest releases</h3>
      {observations.map((row) => (
        <div key={row.environment}>
          <h4>
            {
              ENVIRONMENT_LABELS[
                row.environment as keyof typeof ENVIRONMENT_LABELS
              ]
            }
          </h4>
          <dl className="detail-list">
            {(
              [
                [
                  "First",
                  row.firstRelease,
                  row.firstAppVersion,
                  row.firstSeen,
                  row.firstSeenKnown,
                ],
                [
                  "Latest",
                  row.lastRelease,
                  row.lastAppVersion,
                  row.lastSeen,
                  true,
                ],
              ] as const
            ).map(([label, name, version, date, known]) => {
              const release = releases.find((item) => item.name === name);

              return (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {!known ? (
                      <span className="muted">Earlier history unavailable</span>
                    ) : name ? (
                      release ? (
                        <Link
                          className="text-link mono"
                          href={`/releases/${release.id}?environment=${row.environment}`}
                        >
                          {releaseLabel(name, release.appVersion ?? version)}
                        </Link>
                      ) : (
                        <span className="mono">
                          {releaseLabel(name, version)}
                        </span>
                      )
                    ) : (
                      <span className="muted">Release not reported</span>
                    )}
                    <small className="muted history-date">
                      {known
                        ? dateTime(date)
                        : `Earliest retained observation: ${dateTime(date)}`}
                    </small>
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      ))}
      <p className="muted small">
        History expires after 90 days without events in an environment.
      </p>
    </section>
  );
}
