import Link from "next/link";

export default function NotFound() {
  return (
    <div className="page">
      <section className="panel">
        <div className="empty-state">
          <span aria-hidden="true">⌁</span>
          <h1>Item not found</h1>
          <p>
            This item is unavailable or no longer belongs to this workspace.
          </p>
          <Link href="/issues" className="button">
            Back to Issues
          </Link>
        </div>
      </section>
    </div>
  );
}
