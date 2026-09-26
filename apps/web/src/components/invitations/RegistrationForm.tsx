"use client";

import { useState } from "react";
import { Form } from "../forms/Form";
import { Control } from "../forms/Control";
import { post } from "../forms/utils";

export function RegistrationForm({ token }: { token: string }) {
  const [secret, setSecret] = useState("");
  const [codes, setCodes] = useState<string[]>([]);

  if (codes.length) {
    return (
      <div className="form">
        <h3>Save your recovery codes</h3>
        <p>
          Your account is ready. Store these one-time codes outside
          GetException; they will not be shown again.
        </p>
        <div className="recovery-grid" data-private>
          {codes.map((code) => (
            <code key={code}>{code}</code>
          ))}
        </div>
        <a href="/login?registered=1" className="button primary">
          I saved my codes · Sign in ↗
        </a>
      </div>
    );
  }

  if (secret) {
    return (
      <Form
        button="Create account and join"
        submit={async (data) => {
          const result = await post("/api/invitations/finish-registration", {
            code: data.get("code"),
          });

          setCodes(result.recoveryCodes);
          setSecret("");
        }}
      >
        <p className="muted">
          Add this key to Google Authenticator or another TOTP app, then enter
          its current six-digit code. Your account is created only after this
          check succeeds.
        </p>
        <code className="secret" data-private>
          {secret}
        </code>
        <Control
          label="Authenticator code"
          name="code"
          minLength={6}
          maxLength={6}
          autoComplete="one-time-code"
        />
      </Form>
    );
  }

  return (
    <Form
      button="Continue to authenticator"
      submit={async (data) => {
        const result = await post("/api/invitations/begin-registration", {
          token,
          name: data.get("name"),
          password: data.get("password"),
        });

        setSecret(result.secret);
      }}
    >
      <Control
        label="Your name"
        name="name"
        minLength={2}
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
        Use 12–128 characters. The email in this invitation becomes your login
        identifier. Every sign-in also requires your authenticator.
      </p>
    </Form>
  );
}
