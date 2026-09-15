"use client";

import { useId } from "react";
import { Field } from "@base-ui/react/field";
import { Control } from "../forms/Control";

export interface ProjectValues {
  name: string;
  slug: string;
  origins: string[];
}

export function ProjectFields({ project }: { project?: ProjectValues }) {
  const originsId = useId();

  return (
    <>
      <Control
        label="Project name"
        name="name"
        placeholder="Customer portal"
        maxLength={80}
        defaultValue={project?.name}
      />
      <Control
        label="Project slug"
        name="slug"
        placeholder="customer-portal"
        maxLength={64}
        defaultValue={project?.slug}
      />
      <Field.Root className="field">
        <Field.Label htmlFor={originsId}>
          Allowed origins · one per line
        </Field.Label>
        <textarea
          id={originsId}
          name="origins"
          required
          rows={5}
          maxLength={6020}
          placeholder="https://app.example.com"
          defaultValue={project?.origins.join("\n")}
        />
      </Field.Root>
      <p className="muted small">
        Add up to 20 exact origins, one per line. Include the protocol and port,
        for example https://app.example.com or http://localhost:8080. HTTP is
        allowed only for localhost, 127.0.0.1 and [::1]. Local events must use
        environment: development.
      </p>
      <p className="muted small">
        Origins filter browser traffic; a public DSN grants no access to stored
        errors.
      </p>
    </>
  );
}
