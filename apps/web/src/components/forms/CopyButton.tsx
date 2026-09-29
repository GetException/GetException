"use client";

import { useEffect, useState } from "react";
import { Button } from "@base-ui/react/button";

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timeout = window.setTimeout(() => setCopied(false), 2_000);

    return () => window.clearTimeout(timeout);
  }, [copied]);

  return (
    <>
      <Button
        type="button"
        className="button copy-button"
        disabled={!value}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setFailed(false);
          } catch {
            setFailed(true);
          }
        }}
      >
        {copied ? copiedLabel : label}
      </Button>
      {failed && (
        <span className="copy-error" role="alert">
          Copy failed. Select and copy the value manually.
        </span>
      )}
    </>
  );
}
