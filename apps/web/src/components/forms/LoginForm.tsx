"use client";

import { post } from "./utils";
import { useState } from "react";
import { Control } from "./Control";
import { Form } from "./Form";
import { useRouter } from "next/navigation";
import { Button } from "@base-ui/react/button";
import { OtpInput } from "./OtpInput";

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

        const result = await post("/api/auth/login", {
          email: data.get("email"),
          password: data.get("password"),
          ...(factor
            ? recovery
              ? { recoveryCode: factor }
              : { code: factor }
            : {}),
          trustDevice: false,
        });

        if (result.enrollmentRequired) {
          router.push("/two-factor");
          router.refresh();

          return;
        }

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
      {recovery ? (
        <Control
          label="Recovery code"
          name="factor"
          autoComplete="one-time-code"
          maxLength={32}
          required={false}
        />
      ) : (
        <OtpInput name="factor" required={false} />
      )}
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
