"use client";

import { useRouter } from "next/navigation";
import { Control } from "../forms/Control";
import { Form } from "../forms/Form";
import { ChoiceList } from "../forms/ChoiceList";
import { post } from "../forms/utils";

export function TeamForm({
  team,
  members,
  projects,
}: {
  team?: {
    id: string;
    name: string;
    memberIds: string[];
    projectIds: string[];
  };
  members: { id: string; label: string }[];
  projects: { id: string; label: string }[];
}) {
  const router = useRouter();

  return (
    <Form
      button={team ? "Save team" : "Create team"}
      submit={async (data) => {
        await post(`/api/dashboard/access/teams${team ? `/${team.id}` : ""}`, {
          name: data.get("name"),
          memberIds: data.getAll("memberIds"),
          projectIds: data.getAll("projectIds"),
        });
        router.push("/teams");
        router.refresh();
      }}
    >
      <Control
        name="name"
        label="Team name"
        maxLength={80}
        defaultValue={team?.name}
      />
      <ChoiceList
        label="Members"
        name="memberIds"
        options={members}
        selected={team?.memberIds}
      />
      <ChoiceList
        label="Projects"
        name="projectIds"
        options={projects}
        selected={team?.projectIds}
      />
      <p className="muted small">
        Members can access projects assigned to any of their teams. A project
        must keep at least one team.
      </p>
    </Form>
  );
}
