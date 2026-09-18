"use client";

import {
  MAX_PREVIEW_SOURCES,
  type PreviewSource,
} from "../../lib/source-map-policy";

export function TrustedPreviewSources({
  sources,
  onChange,
}: {
  sources: PreviewSource[];
  onChange: (sources: PreviewSource[]) => void;
}) {
  return (
    <div className="preview-sources">
      <h3>Allowed forks</h3>
      <p className="muted small">
        Add the GitLab project ID and path of each fork you trust. Permission
        covers preview builds from that repository, regardless of who started
        them.
      </p>
      {!sources.length && (
        <p className="muted small">
          No forks added. Only the main repository is allowed.
        </p>
      )}
      {sources.map((source, index) => (
        <fieldset className="preview-source" key={index}>
          <legend>Fork {index + 1}</legend>
          <label>
            GitLab project ID
            <input
              type="number"
              min={1}
              max={2147483647}
              step={1}
              required
              value={source.repositoryId || ""}
              onChange={(event) =>
                onChange(
                  sources.map((item, i) =>
                    i === index
                      ? { ...item, repositoryId: Number(event.target.value) }
                      : item,
                  ),
                )
              }
            />
          </label>
          <label>
            Repository path
            <input
              required
              maxLength={255}
              placeholder="your-name/account"
              value={source.repositoryPath}
              onChange={(event) =>
                onChange(
                  sources.map((item, i) =>
                    i === index
                      ? { ...item, repositoryPath: event.target.value }
                      : item,
                  ),
                )
              }
            />
          </label>
          <button
            type="button"
            className="button secondary"
            aria-label={`Remove fork ${index + 1}`}
            onClick={() => onChange(sources.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="button secondary"
        disabled={sources.length >= MAX_PREVIEW_SOURCES}
        onClick={() =>
          onChange([...sources, { repositoryId: 0, repositoryPath: "" }])
        }
      >
        Add fork
      </button>
      <p className="muted small">
        Use the fork’s Project ID from its GitLab project menu. Changes take
        effect after saving.
      </p>
    </div>
  );
}
