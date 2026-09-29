"use client";

import { useEffect, useRef, useState } from "react";
import { Form } from "./Form";
import { post } from "./utils";
import { AuthenticatorSetup } from "./AuthenticatorSetup";
import { OtpInput } from "./OtpInput";
import { RecoveryCodes } from "./RecoveryCodes";

export function RequiredMfaEnrollment() {
  const requested = useRef(false);
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (requested.current) {
      return;
    }

    requested.current = true;
    void post("/api/mfa/enrollment/details", {})
      .then((result) => {
        setSecret(result.secret);
        setUri(result.uri);
      })
      .catch((error) =>
        setError(
          error instanceof Error
            ? error.message
            : "Unable to start authenticator setup.",
        ),
      );
  }, []);

  if (codes.length) {
    return (
      <div className="form">
        <h3>Save your recovery codes</h3>
        <p>
          Each code works once. Store them outside GetException; they will not
          be shown again.
        </p>
        <RecoveryCodes codes={codes} />
        <a href="/login" className="button primary">
          I saved my codes · Sign in ↗
        </a>
      </div>
    );
  }

  if (error) {
    return (
      <p role="alert" className="alert">
        {error} Sign in again to restart setup.
      </p>
    );
  }

  if (!secret) {
    return <p className="muted">Preparing authenticator setup…</p>;
  }

  return (
    <Form
      button="Activate authenticator"
      submit={async (data) => {
        const result = await post("/api/mfa/enrollment/finish", {
          code: data.get("code"),
        });

        setCodes(result.recoveryCodes);
        setSecret("");
      }}
    >
      <p className="muted">
        Add this key to Google Authenticator or another TOTP app, then enter its
        current six-digit code.
      </p>
      <AuthenticatorSetup secret={secret} uri={uri} />
      <OtpInput />
    </Form>
  );
}
