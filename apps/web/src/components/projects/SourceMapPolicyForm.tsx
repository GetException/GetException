"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Form } from "../forms/Form";
import { StepUpForm } from "../forms/StepUpForm";
import { useProjectMutation } from "./use-project-mutation";
import { TrustedPreviewSources } from "./TrustedPreviewSources";
import {
  sourceMapPolicySchema,
  type SourceMapSettings,
} from "../../lib/source-map-policy";

export function SourceMapPolicyForm({
  projectId,
  settings,
}: {
  projectId: string;
  settings: SourceMapSettings;
}) {
  const router = useRouter();
  const mutation = useProjectMutation();
  const [previewEnabled, setPreviewEnabled] = useState(settings.previewEnabled);
  const [trustedSources, setTrustedSources] = useState(settings.trustedSources);
  const [saved, setSaved] = useState(false);

  return (
    <section className="panel form-panel" id="source-maps">
      <h2>Source maps</h2>
      <p className="muted">
        Choose which builds can send source maps. Error collection continues in
        both modes. Only an Owner can change these permissions.
      </p>
      <div className="source-map-repository">
        <span className="muted small">
          Main repository · production and preview
        </span>
        <strong>{settings.repository.repositoryPath}</strong>
        <span className="muted small">
          {settings.gitlabOrigin} · Project ID{" "}
          {settings.repository.repositoryId}
        </span>
      </div>
      {saved && (
        <p role="status" className="success">
          Source map settings saved. New CI requests use these permissions
          immediately.
        </p>
      )}
      <Form
        button="Save source map settings"
        submit={async () => {
          setSaved(false);
          const result = sourceMapPolicySchema.safeParse({
            previewEnabled,
            trustedSources,
          });

          if (!result.success) {
            throw new Error(
              "Check the project IDs and repository paths. Each fork must appear once.",
            );
          }

          await mutation.run(
            `/api/dashboard/projects/${projectId}/source-map-policy`,
            result.data,
            "PATCH",
          );
          setSaved(true);
          router.refresh();
        }}
      >
        <label>
          Source map delivery
          <select
            value={previewEnabled ? "preview" : "production"}
            onChange={(event) => {
              setPreviewEnabled(event.target.value === "preview");
              setSaved(false);
            }}
          >
            <option value="production">Production only</option>
            <option value="preview">Production and MR</option>
          </select>
        </label>
        <p className="muted small">
          {previewEnabled
            ? "Preview maps are accepted from the main repository and the forks listed below. Forks cannot upload production maps."
            : "Maps from every preview are disabled. Preview deployments and error reporting keep working; new preview builds show compiled stack traces."}{" "}
          Previously uploaded maps stay until their retention period ends.
        </p>
        <TrustedPreviewSources
          sources={trustedSources}
          onChange={(sources) => {
            setTrustedSources(sources);
            setSaved(false);
          }}
        />
        <p className="muted small">
          The list is kept when preview maps are disabled. Your CI must support
          the source map delivery policy before switching modes.
        </p>
      </Form>
      {mutation.needsConfirmation && (
        <StepUpForm onSuccess={mutation.confirmed} />
      )}
    </section>
  );
}
