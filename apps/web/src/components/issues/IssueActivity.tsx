import Link from "next/link";
import { dateTime } from "../../lib/format";

export function IssueActivity({
  issueId,
  activities,
}: {
  issueId: string;
  activities: {
    id: string;
    fromIssueId: string;
    toIssueId: string;
    eventId: string;
    createdAt: Date;
  }[];
}) {
  if (!activities.length) {
    return null;
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Grouping history</h2>
      </div>
      <ul className="activity-list">
        {activities.map((activity) => (
          <li key={activity.id}>
            <span className="muted small">{dateTime(activity.createdAt)}</span>
            {" · "}Source maps restored an event’s original location.{" "}
            {activity.fromIssueId === issueId ? "Moved to " : "Moved from "}
            <Link
              className="text-link"
              href={`/issues/${activity.fromIssueId === issueId ? activity.toIssueId : activity.fromIssueId}`}
            >
              related issue
            </Link>
            .
          </li>
        ))}
      </ul>
    </section>
  );
}
