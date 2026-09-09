"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { post } from "../forms/utils";
import { Form } from "../forms/Form";
import { LoginForm } from "../forms/LoginForm";
import { useFragmentToken } from "./useFragmentToken";

type Preview = {
  workspace: string;
  inviter: string;
  role: string;
  email: string;
  teams: string[];
};

export function InvitationReview() {
  const token = useFragmentToken();
  const router = useRouter();
  const requested = useRef(false);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!token || requested.current) {
      return;
    }

    requested.current = true;
    void post("/api/invitations/preview", { token })
      .then(setPreview)
      .catch((error) =>
        setError(
          error instanceof Error ? error.message : "Unable to open invitation.",
        ),
      );
  }, [token]);

  async function accept() {
    await post("/api/invitations/accept", { token });
    router.push("/");
    router.refresh();
  }

  if (error || token === "") {
    return (
      <p role="alert" className="alert">
        {error ||
          "Open the invitation link from your email. If you refreshed this page, open the link again."}
      </p>
    );
  }

  if (!preview) {
    return <p className="muted">Loading invitation…</p>;
  }

  return (
    <>
      <h2>Join {preview.workspace}</h2>
      <p className="muted">
        {preview.inviter} invited {preview.email} as{" "}
        <strong>{preview.role}</strong>.
      </p>
      <p>Teams: {preview.teams.join(", ")}</p>
      {sent ? (
        <p className="success" role="status">
          Check your email for a separate confirmation link. Open it to set your
          name and password.
        </p>
      ) : (
        <Form
          button="Create an account · verify email"
          submit={async () => {
            await post("/api/invitations/send-verification", { token });
            setSent(true);
          }}
        >
          <p className="muted small">
            Confirm ownership of your email before choosing a password.
          </p>
        </Form>
      )}
      <details className="invite-existing">
        <summary>Already have an account?</summary>
        <p className="muted small">
          Sign in with the email this invitation was sent to.
        </p>
        <LoginForm onSuccess={accept} />
        <Form button="Accept with my signed-in account" submit={accept}>
          <span className="muted small">
            Use your current GetException session.
          </span>
        </Form>
      </details>
    </>
  );
}
