import { actions } from "./constants";
import { PAGE_SIZE } from "../../../lib/pagination";
import { dashboardOwner } from "../../../server/dashboard";
import { getRuntime } from "../../../server/runtime";
import { Empty } from "../../../components/dashboard/Empty";
import { Heading } from "../../../components/dashboard/Heading";
import { Pagination } from "../../../components/dashboard/Pagination";
import { dateTime } from "../../../lib/format";
import { pageNumber, textParam, type Search } from "../../../lib/search-params";
import { tableSort } from "../../../lib/table-sort";
import { auditPageIds } from "../../../server/audit/list";
import { inPageOrder } from "../../../server/table-order";
import { SortableTableHead } from "../../../components/dashboard/SortableTableHead";
import { SortFields } from "../../../components/dashboard/SortFields";

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const { member } = await dashboardOwner();
  const { db } = getRuntime();
  const search = await searchParams;
  const page = pageNumber(search.page);
  const action = textParam(search.action);
  const outcome = textParam(search.outcome);
  const sorting = tableSort(search, "audit");
  const values = { action, outcome, ...sorting };
  const where = {
    ...(Object.hasOwn(actions, action) ? { action } : {}),
    ...(["success", "failure"].includes(outcome)
      ? { success: outcome === "success" }
      : {}),
  };
  const ids = await auditPageIds(db, member, action, outcome, sorting, page);
  const [rows, total] = await Promise.all([
    db.auditLog.findMany({
      where: { ...where, id: { in: ids.map(({ id }) => id) } },
      take: PAGE_SIZE,
    }),
    db.auditLog.count({ where }),
  ]);
  const entries = inPageOrder(rows, ids);
  const users = await db.user.findMany({
    where: {
      id: {
        in: [
          ...new Set(
            entries.flatMap((entry) => (entry.actorId ? [entry.actorId] : [])),
          ),
        ],
      },
    },
    select: { id: true, email: true },
  });

  return (
    <div className="page">
      <Heading
        title="Audit log"
        description="A history of sign-ins, identity checks, and workspace changes."
      />
      <section className="panel">
        <form
          key={JSON.stringify([action, outcome])}
          className="filters"
          method="get"
        >
          <SortFields sorting={sorting} />
          <label className="filter-field">
            Action
            <select
              aria-label="Action"
              name="action"
              defaultValue={Object.hasOwn(actions, action) ? action : ""}
            >
              <option value="">All actions</option>
              {Object.entries(actions).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            Result
            <select aria-label="Result" name="outcome" defaultValue={outcome}>
              <option value="">All results</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
            </select>
          </label>
          <button className="button">Apply filters</button>
        </form>
        {entries.length ? (
          <div className="table-scroll">
            <table>
              <SortableTableHead
                table="audit"
                sorting={sorting}
                path="/audit-log"
                values={values}
              />
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="date-cell">{dateTime(entry.createdAt)}</td>
                    <td>{actions[entry.action] ?? entry.action}</td>
                    <td className="muted">
                      {users.find((user) => user.id === entry.actorId)?.email ??
                        (entry.actorId
                          ? "Former member"
                          : "System / unidentified account")}
                    </td>
                    <td>
                      <span
                        className={`pill ${entry.success ? "resolved" : "regression"}`}
                      >
                        {entry.success ? "Success" : "Failure"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No matching activity">
            Adjust the filters to see other workspace activity.
          </Empty>
        )}
        <Pagination
          path="/audit-log"
          values={values}
          page={page}
          total={total}
        />
      </section>
    </div>
  );
}
