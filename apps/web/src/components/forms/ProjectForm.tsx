"use client";

import { post } from "./utils";
import { useState } from "react";
import { Control } from "./Control";
import { Form } from "./Form";
import { Field } from "@base-ui/react/field";

export function ProjectForm() {
  const [dsn, setDsn] = useState("");

  if (dsn) {
    return (
      <div className="form">
        <div className="success-mark">✓</div>
        <h2>Your project is ready</h2>
        <p className="muted">
          Save this write-only DSN and pass it to <code>init</code> in your SPA.
          The key is shown once.
        </p>
        <code className="secret" data-private data-testid="project-dsn">
          {dsn}
        </code>
        <a className="button primary" href="/issues">
          Open issues ↗
        </a>
      </div>
    );
  }

  return (
    <Form
      button="Create project"
      submit={async (data) => {
        const result = await post("/api/dashboard/projects", {
          name: data.get("name"),
          slug: data.get("slug"),
          origins: String(data.get("origins"))
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        });

        setDsn(result.dsn);
      }}
    >
      <Control
        label="Project name"
        name="name"
        placeholder="Customer portal"
        maxLength={80}
      />
      <Control
        label="Project slug"
        name="slug"
        placeholder="customer-portal"
        maxLength={64}
      />
      <Field.Root className="field">
        <Field.Label htmlFor="project-origins">
          Allowed origins · one per line
        </Field.Label>
        <textarea
          id="project-origins"
          name="origins"
          required
          rows={3}
          placeholder="https://app.example.com"
        />
      </Field.Root>
      <p className="muted small">
        An origin includes its protocol and port. It filters browser traffic; a
        public DSN grants no access to stored errors.
      </p>
    </Form>
  );
}
