"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@base-ui/react/button";

export function Form({
  children,
  submit,
  button,
}: {
  children: ReactNode;
  submit: (data: FormData) => Promise<void>;
  button: string;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    setError("");
    setBusy(true);

    try {
      await submit(data);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handle} className="form">
      {children}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <Button type="submit" className="button primary" disabled={busy}>
        {busy ? "Please wait…" : button}
        <span aria-hidden="true">↗</span>
      </Button>
    </form>
  );
}
