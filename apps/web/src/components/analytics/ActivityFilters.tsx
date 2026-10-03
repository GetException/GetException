import {
  ACTIVITY_PERIODS,
  type ActivityFilters as Filters,
} from "../../lib/activity";
import { ENVIRONMENT_LABELS } from "../releases/presentation";
import { ProjectSelect } from "../dashboard/ProjectSelect";

export function ActivityFilters({
  filters,
  projects,
  prefix = "",
  preserve = {},
}: {
  filters: Filters;
  projects?: { id: string; name: string }[];
  prefix?: string;
  preserve?: Record<string, string | number | undefined>;
}) {
  return (
    <form
      className="filters activity-filters"
      method="get"
      aria-label="Activity filters"
      key={JSON.stringify(filters)}
    >
      {Object.entries(preserve).map(
        ([name, value]) =>
          value !== undefined && (
            <input key={name} type="hidden" name={name} value={value} />
          ),
      )}
      {projects && (
        <ProjectSelect projects={projects} selected={filters.project} />
      )}
      <label className="filter-field">
        Environment
        <select
          name={prefix ? `${prefix}Environment` : "environment"}
          defaultValue={filters.environment}
        >
          <option value="all">All environments</option>
          {Object.entries(ENVIRONMENT_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="filter-field">
        Period
        <select
          name={prefix ? `${prefix}Period` : "period"}
          defaultValue={filters.period}
        >
          {Object.entries(ACTIVITY_PERIODS).map(([key, value]) => (
            <option key={key} value={key}>
              {value.label}
            </option>
          ))}
        </select>
      </label>
      <button className="button">Apply filters</button>
    </form>
  );
}
