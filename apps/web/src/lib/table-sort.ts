import { textParam, type Search } from "./search-params";

export type SortDirection = "asc" | "desc";

export type TableSort = { sort: string; direction: SortDirection };

export type SortColumn = {
  key: string;
  label: string;
  direction?: SortDirection;
  numeric?: boolean;
  title?: string;
};

export const tableColumns = {
  issues: [
    { key: "issue", label: "Issue" },
    { key: "project", label: "Project" },
    { key: "status", label: "Status" },
    {
      key: "events",
      label: "Total events",
      numeric: true,
      direction: "desc",
      title: "Lifetime count across all environments",
    },
    { key: "first", label: "First seen", direction: "desc" },
    { key: "recent", label: "Last seen", direction: "desc" },
  ],
  releases: [
    { key: "version", label: "Version / project" },
    { key: "environment", label: "Environment" },
    { key: "review", label: "Merge request", direction: "desc" },
    { key: "latest", label: "Latest event", direction: "desc" },
    { key: "events", label: "Events", numeric: true, direction: "desc" },
    { key: "maps", label: "Source maps" },
  ],
  projects: [
    { key: "project", label: "Project" },
    { key: "teams", label: "Teams" },
    { key: "status", label: "Status" },
    { key: "issues", label: "Open issues", numeric: true, direction: "desc" },
    {
      key: "events",
      label: "Retained events",
      numeric: true,
      direction: "desc",
    },
    { key: "created", label: "Created", direction: "desc" },
  ],
  members: [
    { key: "member", label: "Member" },
    { key: "role", label: "Role" },
    { key: "teams", label: "Teams" },
    { key: "mfa", label: "Two-factor auth" },
    { key: "status", label: "Status" },
    { key: "joined", label: "Joined", direction: "asc" },
  ],
  invitations: [
    { key: "email", label: "Email" },
    { key: "role", label: "Role" },
    { key: "status", label: "Status" },
    { key: "expires", label: "Expires · UTC", direction: "desc" },
  ],
  audit: [
    { key: "time", label: "Time · UTC", direction: "desc" },
    { key: "action", label: "Action" },
    { key: "actor", label: "Actor" },
    { key: "result", label: "Result" },
  ],
  events: [
    { key: "time", label: "Time · UTC", direction: "desc" },
    { key: "event", label: "Event" },
    { key: "release", label: "Release" },
    { key: "environment", label: "Environment" },
    { key: "level", label: "Level" },
    { key: "handling", label: "Handling" },
  ],
  releaseIssues: [
    { key: "issue", label: "Issue" },
    { key: "status", label: "Status" },
    {
      key: "events",
      label: "Events in release",
      numeric: true,
      direction: "desc",
    },
  ],
  keys: [
    { key: "created", label: "Created", direction: "desc" },
    { key: "status", label: "Status" },
    { key: "expires", label: "Expires", direction: "desc" },
  ],
} satisfies Record<string, SortColumn[]>;

export type TableName = keyof typeof tableColumns;

const defaults: Record<TableName, string> = {
  issues: "recent",
  releases: "latest",
  projects: "created",
  members: "joined",
  invitations: "expires",
  audit: "time",
  events: "time",
  releaseIssues: "events",
  keys: "created",
};

export function sortParams(prefix = "") {
  return {
    sort: prefix ? `${prefix}Sort` : "sort",
    direction: prefix ? `${prefix}Direction` : "direction",
    page: prefix ? `${prefix}Page` : "page",
  };
}

export function tableSort(
  search: Search,
  table: TableName,
  prefix = "",
): TableSort {
  const keys = sortParams(prefix);
  const columns: SortColumn[] = tableColumns[table];
  const column =
    columns.find(({ key }) => key === textParam(search[keys.sort])) ??
    columns.find(({ key }) => key === defaults[table])!;
  const direction = textParam(search[keys.direction]);

  return {
    sort: column.key,
    direction:
      direction === "asc" || direction === "desc"
        ? direction
        : (column.direction ?? "asc"),
  };
}

export function sortValues(sorting: TableSort, prefix = "") {
  const keys = sortParams(prefix);

  return { [keys.sort]: sorting.sort, [keys.direction]: sorting.direction };
}
