import { actions } from "./constants";
import { PAGE_SIZE } from "../../../lib/pagination";
import { dashboardOwner } from "../../../server/dashboard";
import { getRuntime } from "../../../server/runtime";
import { Empty } from "../../../components/dashboard/Empty";
import { Heading } from "../../../components/dashboard/Heading";
import { Pagination } from "../../../components/dashboard/Pagination";
import { dateTime } from "../../../lib/format";
import { pageNumber, textParam, type Search } from "../../../lib/search-params";

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await dashboardOwner();
  const { db } = getRuntime();
  const search = await searchParams;
  const page = pageNumber(search.page);
  const action = textParam(search.action);
  const outcome = textParam(search.outcome);
  const where = {
    ...(Object.hasOwn(actions, action) ? { action } : {}),
    ...(["success", "failure"].includes(outcome)
      ? { success: outcome === "success" }
      : {}),
  };
  const [entries, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.auditLog.count({ where }),
  ]);
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
        <form className="filters" method="get">
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
              <thead>
                <tr>
                  <th>Time · UTC</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Result</th>
                </tr>
              </thead>
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
          values={{ action, outcome }}
          page={page}
          total={total}
        />
      </section>
    </div>
  );
}
