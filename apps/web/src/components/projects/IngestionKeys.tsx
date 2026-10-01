"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Form } from "../forms/Form";
import { StepUpForm } from "../forms/StepUpForm";
import { CopyButton } from "../forms/CopyButton";
import { useProjectMutation } from "./use-project-mutation";
import { dateTime } from "../../lib/format";

export function IngestionKeys({
  projectId,
  keys,
}: {
  projectId: string;
  keys: { id: string; createdAt: string; expiresAt: string | null }[];
}) {
  const [created, setCreated] = useState<{ id: string; dsn: string } | null>(
    null,
  );
  const mutation = useProjectMutation();
  const router = useRouter();

  return (
    <section className="panel form-panel">
      <h2>Event ingestion DSN</h2>
      <p className="muted">
        Replace a lost or abused DSN, then update your application. Previous
        keys continue working for up to 24 hours. The new DSN is shown once.
      </p>
      {created && (
        <div className="upload-token-notice" role="status">
          <strong>Save this DSN in your application configuration.</strong>
          <pre className="mono">{created.dsn}</pre>
          <CopyButton value={created.dsn} label="Copy DSN" />
        </div>
      )}
      <Form
        button="Replace DSN"
        submit={async (data) => {
          setCreated(
            (await mutation.run(
              `/api/dashboard/projects/${projectId}/ingestion-keys`,
              {
                revokeImmediately: data.get("revokeImmediately") === "on",
              },
              "POST",
            )) as { id: string; dsn: string },
          );
          router.refresh();
        }}
      >
        <label>
          <input type="checkbox" name="revokeImmediately" /> Revoke all previous
          keys immediately. Applications using them will stop sending events.
        </label>
      </Form>
      {!keys.length && (
        <p className="muted">
          No active keys. Replace the DSN to resume receiving events.
        </p>
      )}
      {keys.map((key) => (
        <div key={key.id} className="upload-token-row">
          <div>
            <strong>Created {dateTime(new Date(key.createdAt))}</strong>
            <p className="muted small">
              {key.expiresAt
                ? `Expires ${dateTime(new Date(key.expiresAt))}`
                : "Current key"}
            </p>
          </div>
          <Form
            button="Revoke key"
            submit={async () => {
              await mutation.run(
                `/api/dashboard/projects/${projectId}/ingestion-keys/${key.id}`,
                {},
                "DELETE",
              );

              if (created?.id === key.id) {
                setCreated(null);
              }

              router.refresh();
            }}
          >
            <label>
              <input type="checkbox" required /> Stop receiving events with this
              key
            </label>
          </Form>
        </div>
      ))}
      {mutation.needsConfirmation && (
        <StepUpForm onSuccess={mutation.confirmed} />
      )}
    </section>
  );
}
