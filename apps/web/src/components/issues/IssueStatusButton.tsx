"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@base-ui/react/button";

export function IssueStatusButton({
  id,
  status,
  eventCount,
}: {
  id: string;
  status: string;
  eventCount: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [refreshing, startRefresh] = useTransition();

  return (
    <div className="issue-action">
      <Button
        className={`button ${status === "resolved" ? "" : "primary"}`}
        disabled={pending || refreshing}
        onClick={async () => {
          setPending(true);
          setError("");

          try {
            const response = await fetch(`/api/dashboard/issues/${id}/status`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                status: status === "resolved" ? "open" : "resolved",
                eventCount,
              }),
              credentials: "same-origin",
              cache: "no-store",
            });

            if (!response.ok) {
              setError(
                response.status === 409
                  ? "New activity arrived. Refresh this page before changing its status."
                  : "Unable to change status. Please try again.",
              );

              return;
            }

            startRefresh(() => router.refresh());
          } catch {
            setError("Unable to reach the server. Please try again.");
          } finally {
            setPending(false);
          }
        }}
      >
        {pending || refreshing
          ? "Saving…"
          : status === "resolved"
            ? "Reopen issue"
            : "✓ Resolve issue"}
      </Button>
      {error && (
        <p className="action-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
