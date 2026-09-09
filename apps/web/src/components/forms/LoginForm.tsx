"use client";

import { post } from "./utils";
import { useState } from "react";
import { Control } from "./Control";
import { Form } from "./Form";
import { useRouter } from "next/navigation";
import { Button } from "@base-ui/react/button";

export function LoginForm({
  onSuccess,
}: { onSuccess?: () => Promise<void> } = {}) {
  const router = useRouter();
  const [recovery, setRecovery] = useState(false);

  return (
    <Form
      button="Sign in"
      submit={async (data) => {
        const factor = String(data.get("factor") ?? "").trim();

        await post("/api/auth/login", {
          email: data.get("email"),
          password: data.get("password"),
          ...(factor
            ? recovery
              ? { recoveryCode: factor }
              : { code: factor }
            : {}),
          trustDevice: false,
        });

        if (onSuccess) {
          await onSuccess();

          return;
        }

        router.push("/");
        router.refresh();
      }}
    >
      <Control
        label="Email"
        name="email"
        type="email"
        autoComplete="username"
      />
      <Control
        label="Password"
        name="password"
        type="password"
        maxLength={128}
        autoComplete="current-password"
      />
      <Control
        label={recovery ? "Recovery code" : "Authenticator code · if enabled"}
        name="factor"
        autoComplete="one-time-code"
        maxLength={recovery ? 32 : 6}
        required={false}
      />
      <Button
        className="text-button"
        type="button"
        onClick={() => setRecovery(!recovery)}
      >
        {recovery ? "Use my authenticator" : "Use a recovery code"}
      </Button>
    </Form>
  );
}
