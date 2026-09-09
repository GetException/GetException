"use client";

import Link from "next/link";

export default function DashboardError({ reset }: { reset: () => void }) {
  return (
    <div className="page">
      <section className="panel">
        <div className="empty-state">
          <span aria-hidden="true">⌁</span>
          <h1>Unable to load this page</h1>
          <p>
            Your workspace could not be reached. Try loading the page again.
          </p>
          <div className="actions centered-actions">
            <button className="button primary" onClick={reset}>
              Try again
            </button>
            <Link className="button" href="/">
              Back to Overview
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
