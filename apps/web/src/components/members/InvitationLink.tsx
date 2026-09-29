"use client";

import { useEffect, useState } from "react";
import { CopyButton } from "../forms/CopyButton";

export function InvitationLink({
  token,
  expiresAt,
}: {
  token: string;
  expiresAt: string;
}) {
  const [link, setLink] = useState("");

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
      <CopyButton value={link} label="Copy invitation link" />
    </div>
  );
}
