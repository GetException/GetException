"use client";

import { useId, useState } from "react";
import {
  ACTIVITY_PERIODS,
  activityTime,
  percentage,
  type ActivityData,
  type ActivityGroup,
  type ActivityPeriod,
} from "../../lib/activity";
import { number } from "../../lib/format";
import { ACTIVITY_SERIES } from "./constants";

export function ActivityChart({
  data,
  period,
  title = "Error activity",
}: {
  data: ActivityData;
  period: ActivityPeriod;
  title?: string;
}) {
  const [group, setGroup] = useState<ActivityGroup>("environment");
  const [focused, setFocused] = useState<number | null>(null);
  const detailId = useId();
  const series = ACTIVITY_SERIES[group];
  const peak = Math.max(1, ...data.buckets.map((bucket) => bucket.count));
  const ticks = [...new Set([0, Math.floor(peak / 2), peak])];
  const bucket = focused === null ? undefined : data.buckets[focused];
  const step = 880 / data.buckets.length;
  const description = `${number(data.total)} events · ${ACTIVITY_PERIODS[period].label} · UTC`;

  return (
    <section className="panel activity-chart" aria-label={title}>
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
          <p className="muted">{description}</p>
        </div>
        <label className="chart-group">
          Split by
          <select
            value={group}
            onChange={(event) =>
              setGroup(
                event.target.value === "handling" ? "handling" : "environment",
              )
            }
          >
            <option value="environment">Environment</option>
            <option value="handling">Handled / unhandled</option>
          </select>
        </label>
      </div>
      <div className="activity-legend" aria-label="Chart legend">
        {series.map((item) => (
          <span key={item.key}>
            <i style={{ background: item.color }} aria-hidden="true" />
            {item.label}
            <strong>
              {number(
                data.buckets.reduce((sum, value) => sum + value[item.key], 0),
              )}
            </strong>
          </span>
        ))}
      </div>
      {data.total ? (
        <>
          <div className="activity-plot">
            <svg
              viewBox="0 0 960 190"
              className="activity-svg"
              aria-label={description}
              onMouseLeave={() => setFocused(null)}
            >
              {ticks.map((value) => (
                <g key={value}>
                  <line
                    x1="52"
                    x2="940"
                    y1={155 - (value / peak) * 125}
                    y2={155 - (value / peak) * 125}
                    className="chart-grid"
                  />
                  <text x="43" y={159 - (value / peak) * 125} textAnchor="end">
                    {number(value)}
                  </text>
                </g>
              ))}
              {data.buckets.map((value, index) => {
                let offset = 0;
                const label = `${activityTime(value.start)} – ${activityTime(value.end)} UTC: ${number(value.count)} events. ${series.map((item) => `${item.label}: ${number(value[item.key])}`).join(". ")}`;

                return (
                  <g
                    key={value.start}
                    role="img"
                    tabIndex={0}
                    aria-label={label}
                    aria-describedby={focused === index ? detailId : undefined}
                    onFocus={() => setFocused(index)}
                    onBlur={() => setFocused(null)}
                    onMouseEnter={() => setFocused(index)}
                    onClick={() => setFocused(index)}
                    className="activity-bin"
                  >
                    <title>{label}</title>
                    <rect
                      x={55 + index * step}
                      y="20"
                      width={Math.max(4, step - 5)}
                      height="137"
                      className={`activity-hit ${focused === index ? "active" : ""}`}
                    />
                    {series.map((item) => {
                      const height = (value[item.key] / peak) * 125;

                      offset += height;

                      return (
                        <rect
                          key={item.key}
                          x={56 + index * step}
                          y={155 - offset}
                          width={Math.max(2, step - 7)}
                          height={height}
                          fill={item.color}
                          pointerEvents="none"
                        />
                      );
                    })}
                  </g>
                );
              })}
            </svg>
            <div className="activity-axis">
              <span>
                {activityTime(data.buckets[0]!.start, period === "24h")}
              </span>
              <span>
                {activityTime(data.buckets.at(-1)!.end, period === "24h")} UTC
              </span>
            </div>
          </div>
          <p className="activity-readout" id={detailId}>
            {bucket
              ? `${activityTime(bucket.start)} – ${activityTime(bucket.end)} UTC · ${number(bucket.count)} events · ${series.map((item) => `${item.label}: ${number(bucket[item.key])}`).join(" · ")}`
              : "Hover, tap, or focus a bar to see its time range and counts."}
          </p>
        </>
      ) : (
        <div className="activity-empty">
          <strong>No events in this view</strong>
          <span>Try another period, environment, or project.</span>
        </div>
      )}
      <div className="activity-quality">
        <span>
          Original source context{" "}
          <strong>{percentage(data.mapped, data.total)}</strong> ·{" "}
          {number(data.mapped)} / {number(data.total)} events
        </span>
        <span>
          Fatal events <strong>{number(data.fatal)}</strong>
        </span>
      </div>
    </section>
  );
}
