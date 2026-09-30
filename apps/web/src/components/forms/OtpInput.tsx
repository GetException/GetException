"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { Field } from "@base-ui/react/field";

const DIGITS = 6;

export function OtpInput({
  label = "Authenticator code",
  name = "code",
  autoSubmit = true,
  required = true,
}: {
  label?: string;
  name?: string;
  autoSubmit?: boolean;
  required?: boolean;
}) {
  const id = useId();
  const [digits, setDigits] = useState(() => Array<string>(DIGITS).fill(""));
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const lastSubmitted = useRef("");
  const value = digits.join("");

  useEffect(() => {
    if (
      !autoSubmit ||
      value.length !== DIGITS ||
      lastSubmitted.current === value
    ) {
      return;
    }

    const form = inputs.current[0]?.form;

    // Submit after React has committed the last digit to the hidden form field.
    if (form?.reportValidity()) {
      lastSubmitted.current = value;
      form.requestSubmit();
    }
  }, [autoSubmit, value]);

  function update(next: string[], focus?: number) {
    const value = next.join("");

    setDigits(next);

    if (value.length < DIGITS) {
      lastSubmitted.current = "";
    }

    if (focus !== undefined) {
      inputs.current[focus]?.focus();
      inputs.current[focus]?.select();
    }
  }

  function fillFrom(index: number, value: string) {
    const incoming = value.replace(/\D/g, "").slice(0, DIGITS - index);

    if (!incoming) {
      return;
    }

    const next = [...digits];

    for (let offset = 0; offset < incoming.length; offset += 1) {
      next[index + offset] = incoming[offset]!;
    }

    update(next, Math.min(index + incoming.length, DIGITS - 1));
  }

  function change(index: number, event: ChangeEvent<HTMLInputElement>) {
    const value = event.currentTarget.value.replace(/\D/g, "");

    if (value.length > 1) {
      fillFrom(index, value);

      return;
    }

    const next = [...digits];

    next[index] = value;
    update(next, value && index < DIGITS - 1 ? index + 1 : undefined);
  }

  function keyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && !digits[index] && index > 0) {
      event.preventDefault();
      const next = [...digits];

      next[index - 1] = "";
      update(next, index - 1);
    }

    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      inputs.current[index - 1]?.focus();
    }

    if (event.key === "ArrowRight" && index < DIGITS - 1) {
      event.preventDefault();
      inputs.current[index + 1]?.focus();
    }
  }

  function paste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    fillFrom(0, event.clipboardData.getData("text"));
  }

  return (
    <Field.Root className="field otp-field">
      <Field.Label id={`${id}-label`}>{label}</Field.Label>
      <div
        className="otp-input"
        role="group"
        aria-labelledby={`${id}-label`}
        onPaste={paste}
      >
        {digits.map((digit, index) => (
          <input
            key={index}
            ref={(element) => {
              inputs.current[index] = element;
            }}
            className="otp-cell"
            type="text"
            inputMode="numeric"
            pattern="[0-9]"
            autoComplete={index === 0 ? "one-time-code" : "off"}
            aria-label={`${label}, digit ${index + 1}`}
            maxLength={1}
            required={required}
            value={digit}
            onChange={(event) => change(index, event)}
            onKeyDown={(event) => keyDown(index, event)}
            onFocus={(event) => event.currentTarget.select()}
          />
        ))}
      </div>
      <input type="hidden" name={name} value={value} />
    </Field.Root>
  );
}
