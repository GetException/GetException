"use client";

import { useRouter } from "next/navigation";
import { Control } from "../forms/Control";
import { Form } from "../forms/Form";
import { StepUpForm } from "../forms/StepUpForm";
import { useStepUpMutation } from "../forms/use-step-up-mutation";

export function DeleteMemberForm({ id, email }: { id: string; email: string }) {
  const router = useRouter();
  const mutation = useStepUpMutation();

  return (
    <>
      <p className="muted">
        This permanently deletes the account, password, authenticator and
        recovery codes, and signs the member out on every device. Invitations
        sent to or created by this member are also removed. Projects, collected
        errors and audit history stay. To return, this person will need a new
        invitation.
      </p>
      <p>
        Type <strong>{email}</strong> to confirm.
      </p>
      <Form
        button="Delete member"
        danger
        submit={async (data) => {
          await mutation.run(
            `/api/dashboard/access/members/${id}`,
            {
              email: data.get("confirmation"),
            },
            "DELETE",
          );
          router.push("/members");
          router.refresh();
        }}
      >
        <Control
          label="Confirm member email"
          name="confirmation"
          type="email"
          autoComplete="off"
          maxLength={254}
        />
      </Form>
      {mutation.needsConfirmation && (
        <StepUpForm onSuccess={mutation.confirmed} />
      )}
    </>
  );
}
