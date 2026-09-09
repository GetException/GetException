"use client";

import { Input } from "@base-ui/react/input";
import { Field } from "@base-ui/react/field";

export function Control({
  label,
  name,
  type = "text",
  ...props
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  defaultValue?: string;
  autoComplete?: string;
  placeholder?: string;
}) {
  return (
    <Field.Root className="field">
      <Field.Label>{label}</Field.Label>
      <Input name={name} type={type} required {...props} />
    </Field.Root>
  );
}
