"use client";

import { useRouter } from "next/navigation";
import { Form } from "../forms/Form";
import { ChoiceList } from "../forms/ChoiceList";
import { post } from "../forms/utils";

export function MemberForm({
  member,
  teams,
}: {
  member: {
    id: string;
    role: string;
    active: boolean;
    teamIds: string[];
    mfa: boolean;
  };
  teams: { id: string; name: string }[];
}) {
  const router = useRouter();

  return (
    <Form
      button="Save access"
      submit={async (data) => {
        const result = await post(
          `/api/dashboard/access/members/${member.id}`,
          {
            role: data.get("role"),
            active: data.get("active") === "on",
            teamIds: data.getAll("teamIds"),
          },
        );

        router.push(result.signedOut ? "/login" : "/members");
        router.refresh();
      }}
    >
      <label className="field">
        Role
        <select name="role" defaultValue={member.role}>
          <option value="viewer">Viewer</option>
          <option value="developer">Developer</option>
          <option value="owner" disabled={!member.mfa}>
            Owner{!member.mfa ? " · authenticator required" : ""}
          </option>
        </select>
      </label>
      <label className="choice-item">
        <input name="active" type="checkbox" defaultChecked={member.active} />{" "}
        Active access
      </label>
      <ChoiceList
        name="teamIds"
        label="Teams"
        selected={member.teamIds}
        options={teams.map((team) => ({ id: team.id, label: team.name }))}
      />
      <p className="muted small">
        Owners can access all projects. Changes sign this member out of their
        existing sessions. At least one active Owner must remain.
      </p>
    </Form>
  );
}
