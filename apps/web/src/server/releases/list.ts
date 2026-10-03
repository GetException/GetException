import { Prisma, type Database } from "@getexception/db";
import { projectScopeSql, type AccessMember } from "../access";
import { sqlOrder, sqlPage } from "../table-order";
import type { TableSort } from "../../lib/table-sort";
import {
  ENVIRONMENT_LABELS,
  SOURCE_MAP_STATES,
} from "../../components/releases/presentation";
import type { releaseFilters } from "./filters";

export function releasePageIds(
  db: Database,
  member: AccessMember,
  filters: ReturnType<typeof releaseFilters>,
) {
  const { project, q, environment, review, maps, page } = filters;
  const mapState = Prisma.sql`CASE WHEN r."sourceMapsState" = 'missing' AND r."sourceMapsVersion" > 0 THEN 'removed' ELSE r."sourceMapsState" END`;
  const mapLabel = Prisma.sql`CASE ${mapState} ${Prisma.join(
    Object.entries(SOURCE_MAP_STATES).map(
      ([key, value]) => Prisma.sql`WHEN ${key} THEN ${value.label}`,
    ),
    " ",
  )} ELSE 'Not uploaded' END`;
  const environmentLabel = Prisma.sql`CASE d.environment ${Prisma.join(
    Object.entries(ENVIRONMENT_LABELS).map(
      ([key, value]) => Prisma.sql`WHEN ${key} THEN ${value}`,
    ),
    " ",
  )} ELSE NULL END`;
  const eventScope = Prisma.sql`e."projectId" = r."projectId" AND e.release = r.name ${environment !== "all" ? Prisma.sql`AND e.environment = ${environment}` : Prisma.empty}`;
  const columns = {
    version: Prisma.sql`lower(r.name)`,
    environment: Prisma.sql`(SELECT string_agg(labels.label, ', ' ORDER BY labels.label) FROM
      (SELECT DISTINCT ${environmentLabel} AS label FROM release_deployment d WHERE d."releaseId" = r.id) labels)`,
    review: Prisma.sql`(SELECT min(split_part(d."reviewKey", ':', 3)::bigint) FROM release_deployment d WHERE d."releaseId" = r.id AND d."reviewKey" ~ '^gitlab:[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$')`,
    latest: Prisma.sql`(SELECT max(e."receivedAt") FROM error_event e WHERE ${eventScope})`,
    events: Prisma.sql`(SELECT count(*) FROM error_event e WHERE ${eventScope})`,
    maps: mapLabel,
  };

  return db.$queryRaw<
    { id: string }[]
  >(Prisma.sql`SELECT r.id FROM release r JOIN project p ON p.id = r."projectId"
    WHERE ${projectScopeSql(member)}
    ${project ? Prisma.sql`AND p.id = ${project}` : Prisma.empty}
    ${q ? Prisma.sql`AND r.name ILIKE ${`%${q}%`}` : Prisma.empty}
    ${maps === "unavailable" ? Prisma.sql`AND r."sourceMapsState" IN ('missing', 'removed', 'failed')` : maps !== "all" ? Prisma.sql`AND ${mapState} = ${maps}` : Prisma.empty}
    ${
      environment !== "all" || review
        ? Prisma.sql`AND EXISTS (SELECT 1 FROM release_deployment d WHERE d."releaseId" = r.id
      ${environment !== "all" ? Prisma.sql`AND d.environment = ${environment}` : Prisma.empty}
      ${review ? Prisma.sql`AND d."reviewKey" = ${review}` : Prisma.empty})`
        : Prisma.empty
    }
    ORDER BY ${sqlOrder(columns, filters, "latest", Prisma.sql`r.id`)} ${sqlPage(page)}`);
}

export function releaseIssuePageIds(
  db: Database,
  projectId: string,
  release: string,
  environment: string,
  sorting: TableSort,
  page: number,
) {
  const eventScope = Prisma.sql`e."projectId" = i."projectId" AND e."issueId" = i.id AND e.release = ${release} ${environment !== "all" ? Prisma.sql`AND e.environment = ${environment}` : Prisma.empty}`;
  const columns = {
    issue: Prisma.sql`lower(i."exceptionType" || ': ' || i.title)`,
    status: Prisma.sql`CASE WHEN i.status = 'open' AND i.regression THEN 'regression' ELSE i.status END`,
    events: Prisma.sql`(SELECT count(*) FROM error_event e WHERE ${eventScope})`,
  };

  return db.$queryRaw<
    { id: string }[]
  >(Prisma.sql`SELECT i.id FROM issue i WHERE i."projectId" = ${projectId}
    AND EXISTS (SELECT 1 FROM error_event e WHERE ${eventScope})
    ORDER BY ${sqlOrder(columns, sorting, "events", Prisma.sql`i.id`)} ${sqlPage(page)}`);
}
