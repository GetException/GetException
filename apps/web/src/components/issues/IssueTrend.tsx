import type { TrendDay } from "../../server/issues/insights";

export function IssueTrend({ days }: { days: TrendDay[] }) {
  const max = Math.max(1, ...days.map((day) => day.count));
  const total = days.reduce((sum, day) => sum + day.count, 0);

  return (
    <section
      className="panel issue-trend"
      aria-label="Events in the last seven days"
    >
      <div>
        <h2>Recent activity</h2>
        <p className="muted small">
          Retained events · all environments · UTC · last 7 days
        </p>
      </div>
      <div className="issue-trend-bars">
        {days.map((day) => (
          <div className="issue-trend-day" key={day.date}>
            <span className="mono small">{day.count}</span>
            <span
              className="issue-trend-track"
              role="img"
              aria-label={`${day.date}: ${day.count} events`}
            >
              <span
                className="issue-trend-bar"
                style={{
                  height: `${day.count ? Math.max(6, (day.count / max) * 100) : 0}%`,
                }}
              />
            </span>
            <span className="muted small">{day.date.slice(5)}</span>
          </div>
        ))}
      </div>
      <div className="issue-trend-total">
        <strong>{total}</strong>
        <span className="muted small">events in 7 days</span>
      </div>
    </section>
  );
}
