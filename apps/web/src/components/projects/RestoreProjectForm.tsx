"use client";

import { useRouter } from "next/navigation";
import { Form } from "../forms/Form";
import { StepUpForm } from "../forms/StepUpForm";
import { useStepUpMutation } from "../forms/use-step-up-mutation";

export function RestoreProjectForm({ id }: { id: string }) {
  const router = useRouter();
  const mutation = useStepUpMutation();

  return (
    <>
      <Form
        button="Restore project"
        submit={async () => {
          await mutation.run(
            `/api/dashboard/projects/${id}/restore`,
            {},
            "POST",
          );
          router.push(`/projects/${id}`);
          router.refresh();
        }}
      >
        <p className="muted small">
          Restoring resumes ingestion with the existing DSN and origins.
        </p>
      </Form>
      {mutation.needsConfirmation && (
        <StepUpForm onSuccess={mutation.confirmed} />
      )}
    </>
  );
}
