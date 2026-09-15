"use client";

import { post } from "./utils";
import { useState } from "react";
import { Form } from "./Form";
import { ProjectFields } from "../projects/ProjectFields";
import { projectFormValues } from "../projects/project-form-values";

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
        const result = await post(
          "/api/dashboard/projects",
          projectFormValues(data),
        );

        setDsn(result.dsn);
      }}
    >
      <ProjectFields />
    </Form>
  );
}
