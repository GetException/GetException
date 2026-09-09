"use client";

import { post } from "./utils";
import { useState } from "react";
import { Control } from "./Control";
import { Form } from "./Form";

export function SetupForm({
  access,
  domain,
}: {
  access: boolean;
  domain: string;
}) {
  const [stage, setStage] = useState(access ? 1 : 0);
  const [secret, setSecret] = useState("");
  const [codes, setCodes] = useState<string[]>([]);

  return (
    <>
      <div className="steps" aria-label="Setup progress">
        {["Access", "Account", "Authenticator", "Recovery"].map((label, i) => (
          <span key={label} className={i === stage ? "active" : ""}>
            {i + 1}. {label}
          </span>
        ))}
      </div>
      {stage === 0 && (
        <Form
          button="Unlock setup"
          submit={async (data) => {
            await post("/api/setup/access", { token: data.get("token") });
            setStage(1);
          }}
        >
          <p className="muted">
            Enter the one-time token provided by your installation operator.
          </p>
          <Control
            label="Setup token"
            name="token"
            type="password"
            autoComplete="off"
            maxLength={64}
          />
        </Form>
      )}
      {stage === 1 && (
        <Form
          button="Set up authenticator"
          submit={async (data) => {
            const result = await post("/api/setup/prepare", {
              email: data.get("email"),
              password: data.get("password"),
              domain: data.get("domain"),
            });

            setSecret(result.secret);
            setStage(2);
          }}
        >
          <Control
            label="Installation domain"
            name="domain"
            defaultValue={domain}
          />
          <Control
            label="Owner email"
            name="email"
            type="email"
            autoComplete="username"
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
            Use 12–128 characters. Your password and authenticator are required
            for every sign-in.
          </p>
        </Form>
      )}
      {stage === 2 && (
        <Form
          button="Activate installation"
          submit={async (data) => {
            const result = await post("/api/setup/finish", {
              code: data.get("code"),
              trustDevice: false,
            });

            setCodes(result.recoveryCodes);
            setSecret("");
            setStage(3);
          }}
        >
          <p className="muted">
            Add this key to your authenticator as a time-based account. Enter
            its first six-digit code to finish setup.
          </p>
          <code className="secret" data-private>
            {secret}
          </code>
          <Control
            label="Authenticator code"
            name="code"
            autoComplete="one-time-code"
            minLength={6}
            maxLength={6}
          />
        </Form>
      )}
      {stage === 3 && (
        <div className="form">
          <p>
            Save these recovery codes somewhere safe. Each code works once. They
            will never be shown again.
          </p>
          <div className="recovery-grid" data-private>
            {codes.map((code) => (
              <code key={code}>{code}</code>
            ))}
          </div>
          <p className="muted small">
            For sign-in, wait for your authenticator to show a new code.
          </p>
          <a
            href="/login"
            className="button primary"
            onClick={() => setCodes([])}
          >
            I saved my codes · Sign in ↗
          </a>
        </div>
      )}
    </>
  );
}
