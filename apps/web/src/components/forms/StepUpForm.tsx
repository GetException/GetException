"use client";

import { post } from "./utils";
import { useState } from "react";
import { Control } from "./Control";
import { Form } from "./Form";

export function StepUpForm() {
  const [done, setDone] = useState(false);

  return (
    <>
      {done && (
        <p className="success" role="status">
          Identity confirmed for five minutes.
        </p>
      )}
      <Form
        button="Confirm identity"
        submit={async (data) => {
          await post("/api/dashboard/step-up", {
            password: data.get("password"),
            code: data.get("code"),
            trustDevice: false,
          });
          setDone(true);
        }}
      >
        <Control
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
        />
        <Control
          label="New authenticator code"
          name="code"
          maxLength={6}
          autoComplete="one-time-code"
        />
      </Form>
    </>
  );
}
