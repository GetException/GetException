"use client";

import { useRouter } from "next/navigation";
import { Control } from "../forms/Control";
import { Form } from "../forms/Form";
import { StepUpForm } from "../forms/StepUpForm";
import { useProjectMutation } from "./use-project-mutation";

export function DeleteProjectForm({ id, slug }: { id: string; slug: string }) {
  const router = useRouter();
  const mutation = useProjectMutation();

  return (
    <>
      <p className="muted">
        Deleting this project stops ingestion immediately and hides its issues
        and releases. You can restore it from Deleted projects for seven days.
        After that, its events, issues, releases, keys and configuration are
        permanently removed.
      </p>
      <p>
        Type <strong className="mono">{slug}</strong> to confirm.
      </p>
      <Form
        button="Delete project"
        danger
        submit={async (data) => {
          await mutation.run(
            `/api/dashboard/projects/${id}`,
            { slug: data.get("confirmation") },
            "DELETE",
          );
          router.push("/projects/deleted");
          router.refresh();
        }}
      >
        <Control
          label="Confirm project slug"
          name="confirmation"
          maxLength={64}
          autoComplete="off"
        />
      </Form>
      {mutation.needsConfirmation && (
        <StepUpForm onSuccess={mutation.confirmed} />
      )}
    </>
  );
}
