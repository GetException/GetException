"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Form } from "../forms/Form";
import { StepUpForm } from "../forms/StepUpForm";
import { useProjectMutation } from "./use-project-mutation";
import { dateTime } from "../../lib/format";

export function SourceMapTokens({
  projectId,
  tokens,
}: {
  projectId: string;
  tokens: {
    id: string;
    name: string;
    expiresAt: string;
    revokedAt: string | null;
  }[];
}) {
  const [secret, setSecret] = useState("");
  const mutation = useProjectMutation();
  const router = useRouter();

  return (
    <section className="panel form-panel">
      <h2>Source map upload tokens</h2>
      <p className="muted">
        Create a token for your CI to upload source maps for this project.
        Tokens expire after 90 days.
      </p>
      {secret && (
        <div className="upload-token-notice" role="status">
          <strong>Save this token in your CI secrets. It is shown once.</strong>
          <pre className="mono">{secret}</pre>
        </div>
      )}
      <Form
        button="Create upload token"
        submit={async (data) => {
          const result = (await mutation.run(
            `/api/dashboard/projects/${projectId}/source-map-tokens`,
            { name: String(data.get("name") ?? "") },
            "POST",
          )) as { token: string };

          setSecret(result.token);
          router.refresh();
        }}
      >
        <label>
          Token name
          <input
            name="name"
            required
            maxLength={80}
            placeholder="Account preview CI"
          />
        </label>
      </Form>
      {tokens.map((token) => (
        <div key={token.id} className="upload-token-row">
          <div>
            <strong>{token.name}</strong>
            <p className="muted small">
              {token.revokedAt
                ? "Revoked"
                : `Expires ${dateTime(new Date(token.expiresAt))}`}
            </p>
          </div>
          {!token.revokedAt && (
            <Form
              button="Revoke token"
              submit={async () => {
                await mutation.run(
                  `/api/dashboard/projects/${projectId}/source-map-tokens/${token.id}`,
                  {},
                  "DELETE",
                );
                setSecret("");
                router.refresh();
              }}
            >
              {null}
            </Form>
          )}
        </div>
      ))}
      {mutation.needsConfirmation && (
        <StepUpForm onSuccess={mutation.confirmed} />
      )}
    </section>
  );
}
