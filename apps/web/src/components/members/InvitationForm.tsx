"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Control } from "../forms/Control";
import { Form } from "../forms/Form";
import { ChoiceList } from "../forms/ChoiceList";
import { post } from "../forms/utils";

export function InvitationForm({
  teams,
}: {
  teams: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [sent, setSent] = useState(false);

  return (
    <>
      {sent && (
        <p className="success" role="status">
          Invitation queued. The recipient will receive an email.
        </p>
      )}
      <Form
        button="Send invitation"
        submit={async (data) => {
          await post("/api/dashboard/access/invitations", {
            email: data.get("email"),
            role: data.get("role"),
            teamIds: data.getAll("teamIds"),
          });
          setSent(true);
          router.refresh();
        }}
      >
        <Control
          label="Email"
          name="email"
          type="email"
          autoComplete="off"
          maxLength={254}
        />
        <label className="field">
          Role
          <select name="role" defaultValue="developer">
            <option value="developer">
              Developer · investigate and resolve
            </option>
            <option value="viewer">Viewer · read only</option>
          </select>
        </label>
        <ChoiceList
          label="Teams · select at least one"
          name="teamIds"
          options={teams.map((team) => ({ id: team.id, label: team.name }))}
        />
        <p className="muted small">
          The invitation is tied to this email and expires in 48 hours. Team
          membership determines which projects are available.
        </p>
      </Form>
    </>
  );
}
