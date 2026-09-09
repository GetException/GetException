import Link from "next/link";
import { linkTo } from "../../lib/search-params";
import { number } from "../../lib/format";
import { PAGE_SIZE, MAX_PAGE } from "../../lib/pagination";

export function Pagination({
  path,
  values,
  page,
  total,
  size = PAGE_SIZE,
}: {
  path: string;
  values: Record<string, string | number | undefined>;
  page: number;
  total: number;
  size?: number;
}) {
  const pages = Math.max(1, Math.min(MAX_PAGE, Math.ceil(total / size)));

  return (
    <footer className="pagination">
      <span className="muted">
        {number(total)} results · Page {page} of {pages}
      </span>
      <div className="actions">
        {page > 1 ? (
          <Link
            className="button"
            href={linkTo(path, { ...values, page: page - 1 })}
          >
            ← Previous
          </Link>
        ) : (
          <span className="button disabled" aria-disabled="true">
            ← Previous
          </span>
        )}
        {page < pages ? (
          <Link
            className="button"
            href={linkTo(path, { ...values, page: page + 1 })}
          >
            Next →
          </Link>
        ) : (
          <span className="button disabled" aria-disabled="true">
            Next →
          </span>
        )}
      </div>
    </footer>
  );
}
