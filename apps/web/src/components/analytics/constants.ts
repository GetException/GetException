import { ENVIRONMENT_LABELS } from "../releases/presentation";
import type { ActivitySeries, ActivityGroup } from "../../lib/activity";

export const ACTIVITY_SERIES: Record<
  ActivityGroup,
  { key: ActivitySeries; label: string; color: string }[]
> = {
  environment: [
    {
      key: "production",
      label: ENVIRONMENT_LABELS.production,
      color: "#73c7ab",
    },
    { key: "staging", label: ENVIRONMENT_LABELS.staging, color: "#ba9cff" },
    {
      key: "development",
      label: ENVIRONMENT_LABELS.development,
      color: "#70b7ef",
    },
  ],
  handling: [
    { key: "unhandled", label: "Unhandled", color: "#f08e91" },
    { key: "handled", label: "Handled", color: "#ba9cff" },
  ],
};
