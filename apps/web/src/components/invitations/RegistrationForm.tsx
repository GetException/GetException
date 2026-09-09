"use client";

import { useRouter } from "next/navigation";
import { Form } from "../forms/Form";
import { LoginForm } from "../forms/LoginForm";
import { Control } from "../forms/Control";
import { post } from "../forms/utils";

export function RegistrationForm({
  email,
  existingAccount,
}: {
  email: string;
  existingAccount: boolean;
}) {
  const router = useRouter();

  if (existingAccount) {
    return (
      <>
        <p className="muted">
          Email confirmed: {email}. Sign in to accept your invitation.
        </p>
        <LoginForm
          onSuccess={async () => {
            await post("/api/invitations/accept-verified", {});
            router.push("/");
            router.refresh();
          }}
        />
      </>
    );
  }

  return (
    <Form
      button="Create account and join"
      submit={async (data) => {
        await post("/api/invitations/register", {
          name: data.get("name"),
          password: data.get("password"),
        });
        router.push("/login?registered=1");
        router.refresh();
      }}
    >
      <p className="success">Email confirmed: {email}</p>
      <Control
        label="Your name"
        name="name"
        maxLength={80}
        autoComplete="name"
      />
      <Control
        label="Password"
        name="password"
        type="password"
        minLength={12}
        maxLength={128}
        autoComplete="new-password"
      />
      <p className="muted small">
        Use 12–128 characters. You can enable an authenticator in Settings after
        signing in.
      </p>
    </Form>
  );
}
