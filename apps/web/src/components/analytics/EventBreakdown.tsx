import Link from "next/link";
import { number } from "../../lib/format";
import { percentage } from "../../lib/activity";

export function EventBreakdown({
  title,
  rows,
  total,
  caption,
}: {
  title: string;
  rows: { label: string; count: number; href?: string; title?: string }[];
  total: number;
  caption: string;
}) {
  const remainder = Math.max(
    0,
    total - rows.reduce((sum, row) => sum + row.count, 0),
  );
  const values = remainder
    ? [...rows, { label: "Other", count: remainder }]
    : rows;

  return (
    <section className="panel event-breakdown">
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
          <p className="muted">{caption}</p>
        </div>
      </div>
      {values.length ? (
        <ul>
          {values.map((row, index) => (
            <li key={`${row.label}-${index}`}>
              <div>
                {row.href ? (
                  <Link className="text-link" href={row.href} title={row.title}>
                    {row.label} ↗
                  </Link>
                ) : (
                  <span title={row.title}>{row.label}</span>
                )}
                <span>
                  {number(row.count)}{" "}
                  <small className="muted">
                    {percentage(row.count, total)}
                  </small>
                </span>
              </div>
              <span className="breakdown-track" aria-hidden="true">
                <span
                  style={{
                    width: total ? `${(row.count / total) * 100}%` : "0%",
                  }}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="content-note">No events in this view.</p>
      )}
    </section>
  );
}
