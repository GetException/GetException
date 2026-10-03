import { textParam, type Search } from "./search-params";
import { ENVIRONMENT_LABELS } from "../components/releases/presentation";

export const ACTIVITY_PERIODS = {
  "24h": { label: "Last 24 hours", hours: 24, buckets: 24 },
  "7d": { label: "Last 7 days", hours: 168, buckets: 7 },
  "30d": { label: "Last 30 days", hours: 720, buckets: 30 },
} as const;

export type ActivityPeriod = keyof typeof ACTIVITY_PERIODS;

export type ActivityFilters = {
  project: string;
  environment: string;
  period: ActivityPeriod;
};

export type ActivityGroup = "environment" | "handling";

export type ActivitySeries =
  "production" | "staging" | "development" | "handled" | "unhandled";

export type ActivityBucket = Record<ActivitySeries, number> & {
  start: string;
  end: string;
  count: number;
};

export type ActivityData = {
  buckets: ActivityBucket[];
  total: number;
  unhandled: number;
  mapped: number;
  fatal: number;
};

export function activityFilters(
  search: Search,
  prefix = "",
  defaultPeriod: ActivityPeriod = "24h",
): ActivityFilters {
  const period = textParam(search[prefix ? `${prefix}Period` : "period"]);
  const environment = textParam(
    search[prefix ? `${prefix}Environment` : "environment"],
  );

  return {
    project: textParam(search.project, 64),
    environment: Object.hasOwn(ENVIRONMENT_LABELS, environment)
      ? environment
      : "all",
    period: Object.hasOwn(ACTIVITY_PERIODS, period)
      ? (period as ActivityPeriod)
      : defaultPeriod,
  };
}

export function activityWindow(period: ActivityPeriod, now = new Date()) {
  const { hours, buckets } = ACTIVITY_PERIODS[period];
  const start = new Date(now.getTime() - hours * 3600_000);

  return { start, end: now, buckets, bucketMs: (hours * 3600_000) / buckets };
}

export function activityDateRange(period: string, now = new Date()) {
  if (!Object.hasOwn(ACTIVITY_PERIODS, period)) {
    return undefined;
  }

  const window = activityWindow(period as ActivityPeriod, now);

  return { gte: window.start, lt: window.end };
}

export function percentage(count: number, total: number) {
  return total ? `${Math.round((count / total) * 100)}%` : "—";
}

export function activityTime(value: string, includeTime = true) {
  return new Date(value).toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}
