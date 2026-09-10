"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@base-ui/react/button";
import { post } from "../forms/utils";

export function InvitationActions({
  id,
  mailEnabled,
}: {
  id: string;
  mailEnabled: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function change(action: "resend" | "revoke") {
    setBusy(true);
    setError("");

    try {
      await post(`/api/dashboard/access/invitations/${id}/${action}`, {});
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="actions">
        <Button
          className="button compact"
          disabled={busy || !mailEnabled}
          onClick={() => change("resend")}
        >
          Resend
        </Button>
        <Button
          className="button compact"
          disabled={busy}
          onClick={() => change("revoke")}
        >
          Revoke
        </Button>
      </div>
      {error && (
        <p className="action-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
