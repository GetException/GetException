"use client";

import { useRouter } from "next/navigation";
import { Form } from "../forms/Form";
import { post } from "../forms/utils";
import { useFragmentToken } from "./useFragmentToken";

export function EmailConfirmation() {
  const token = useFragmentToken();
  const router = useRouter();

  if (token === undefined) {
    return <p className="muted">Opening confirmation…</p>;
  }

  if (!token) {
    return (
      <p role="alert" className="alert">
        Open the confirmation link from your email again.
      </p>
    );
  }

  return (
    <Form
      button="Confirm my email"
      submit={async () => {
        await post("/api/invitations/verify-email", { token });
        router.replace("/invite/register");
      }}
    >
      <p className="muted">
        Continue to confirm your email address and accept your invitation.
      </p>
    </Form>
  );
}
