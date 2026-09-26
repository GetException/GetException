"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@base-ui/react/button";
import { post } from "../forms/utils";
import { InvitationLink } from "./InvitationLink";

export function InvitationActions({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reissued, setReissued] = useState<{
    token: string;
    expiresAt: string;
  }>();

  async function change(action: "reissue" | "revoke") {
    setBusy(true);
    setError("");

    try {
      const result = await post(
        `/api/dashboard/access/invitations/${id}/${action}`,
        {},
      );

      if (action === "reissue") {
        setReissued(result);
      }

      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {reissued && <InvitationLink {...reissued} />}
      <div className="actions">
        <Button
          className="button compact"
          disabled={busy}
          onClick={() => change("reissue")}
        >
          Reissue link
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
