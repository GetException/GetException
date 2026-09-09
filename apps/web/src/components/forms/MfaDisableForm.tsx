"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Form } from "./Form";
import { Control } from "./Control";
import { post } from "./utils";

export function MfaDisableForm() {
  const router = useRouter();
  const [recovery, setRecovery] = useState(false);

  return (
    <details className="invite-existing">
      <summary>Disable authenticator</summary>
      <Form
        button="Disable and sign out"
        submit={async (data) => {
          await post("/api/dashboard/mfa/disable", {
            password: data.get("password"),
            ...(recovery
              ? { recoveryCode: data.get("factor") }
              : { code: data.get("factor") }),
          });
          router.push("/login");
          router.refresh();
        }}
      >
        <Control
          name="password"
          label="Current password"
          type="password"
          maxLength={128}
          autoComplete="current-password"
        />
        <Control
          name="factor"
          label={recovery ? "Recovery code" : "New authenticator code"}
          maxLength={recovery ? 32 : 6}
          autoComplete="one-time-code"
        />
        <label className="choice-item">
          <input
            type="checkbox"
            checked={recovery}
            onChange={(event) => setRecovery(event.target.checked)}
          />
          Use a recovery code
        </label>
      </Form>
    </details>
  );
}
