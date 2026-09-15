"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Form } from "../forms/Form";
import { StepUpForm } from "../forms/StepUpForm";
import { ProjectFields, type ProjectValues } from "./ProjectFields";
import { projectFormValues } from "./project-form-values";
import { useProjectMutation } from "./use-project-mutation";

export function EditProjectForm({
  project,
}: {
  project: ProjectValues & { id: string };
}) {
  const router = useRouter();
  const mutation = useProjectMutation();
  const [saved, setSaved] = useState(false);

  return (
    <>
      {saved && (
        <p className="success" role="status">
          Project saved. The new origins apply immediately; your DSN stays the
          same.
        </p>
      )}
      <Form
        button="Save changes"
        submit={async (data) => {
          setSaved(false);
          await mutation.run(
            `/api/dashboard/projects/${project.id}`,
            projectFormValues(data),
            "PATCH",
          );
          setSaved(true);
          router.refresh();
        }}
      >
        <ProjectFields project={project} />
      </Form>
      {mutation.needsConfirmation && (
        <StepUpForm onSuccess={mutation.confirmed} />
      )}
    </>
  );
}
