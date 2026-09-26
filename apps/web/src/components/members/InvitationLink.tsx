"use client";

import { useEffect, useState } from "react";
import { Button } from "@base-ui/react/button";

export function InvitationLink({
  token,
  expiresAt,
}: {
  token: string;
  expiresAt: string;
}) {
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  useEffect(() => {
    setLink(`${window.location.origin}/invite#${token}`);
  }, [token]);

  return (
    <div className="form">
      <p className="success" role="status">
        Invitation created. This link is shown only now.
      </p>
      <p className="muted small">
        Send it to the intended person through a trusted private channel. It
        expires {new Date(expiresAt).toLocaleString()} and can be used once.
      </p>
      <code className="secret" data-private data-testid="invitation-link">
        {link || "Preparing link…"}
      </code>
      <Button
        type="button"
        className="button primary"
        disabled={!link}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
            setCopyError(false);
          } catch {
            setCopyError(true);
          }
        }}
      >
        {copied ? "Copied" : "Copy invitation link"}
      </Button>
      {copyError && (
        <p className="action-error" role="alert">
          Copy failed. Select the link above and copy it manually.
        </p>
      )}
    </div>
  );
}
