"use client";

import { useState } from "react";
import { Control } from "./Control";
import { Form } from "./Form";
import { post } from "./utils";

export function MfaEnrollment() {
  const [secret, setSecret] = useState("");
  const [codes, setCodes] = useState<string[]>([]);

  if (codes.length) {
    return (
      <div className="form">
        <h3>Save your recovery codes</h3>
        <p>Each code works once. They will not be shown again.</p>
        <div className="recovery-grid" data-private>
          {codes.map((code) => (
            <code key={code}>{code}</code>
          ))}
        </div>
        <a
          href="/login"
          className="button primary"
          onClick={() => setCodes([])}
        >
          I saved my codes · Sign in
        </a>
      </div>
    );
  }

  return secret ? (
    <Form
      button="Enable authenticator"
      submit={async (data) => {
        const result = await post("/api/dashboard/mfa/finish", {
          code: data.get("code"),
        });

        setCodes(result.recoveryCodes);
        setSecret("");
      }}
    >
      <p className="muted">
        Add this key to your authenticator as a time-based account, then enter
        its current code.
      </p>
      <code className="secret" data-private>
        {secret}
      </code>
      <Control
        name="code"
        label="Authenticator code"
        minLength={6}
        maxLength={6}
        autoComplete="one-time-code"
      />
    </Form>
  ) : (
    <Form
      button="Set up authenticator"
      submit={async (data) => {
        const result = await post("/api/dashboard/mfa/prepare", {
          password: data.get("password"),
        });

        setSecret(result.secret);
      }}
    >
      <Control
        name="password"
        label="Current password"
        type="password"
        maxLength={128}
        autoComplete="current-password"
      />
      <p className="muted small">
        Enabling an authenticator signs out your existing sessions. Save the
        recovery codes shown after activation.
      </p>
    </Form>
  );
}
