import type { OriginalFrame, SafeFrame } from "@getexception/protocol";

export function SourceContext({
  frame,
  original,
  state,
}: {
  frame?: SafeFrame;
  original?: OriginalFrame | null;
  state?: string;
}) {
  const location = original ?? frame;
  const lines =
    original?.contextLine === undefined
      ? []
      : [...original.preContext, original.contextLine, ...original.postContext];
  const runtimeFrame =
    !original && frame?.lineno === 0 && frame.filename.includes("<anonymous>");
  const anonymousFrame = !original && frame?.filename.includes("<anonymous>");

  return (
    <section className="panel source-panel">
      <div className="section-heading">
        <h2>Source context</h2>
        <span className="pill">
          {original
            ? "Original source"
            : runtimeFrame
              ? "Browser runtime"
              : anonymousFrame
                ? "No source file"
                : "Source map unavailable"}
        </span>
      </div>
      {location && (
        <div className="source-location mono">
          <span>{location.filename}</span>
          <span className="muted">
            Line {location.lineno} · column {location.colno}
          </span>
        </div>
      )}
      {original && frame && (
        <p className="content-note mono">
          Compiled: {frame.filename}:{frame.lineno}:{frame.colno}
        </p>
      )}
      {lines.length && original ? (
        <div className="source-code" aria-label="Original source code">
          {lines.map((line, index) => (
            <div
              key={index}
              className={`source-code-line ${index === original.preContext.length ? "source-code-error" : ""}`}
            >
              <span className="muted">
                {original.lineno - original.preContext.length + index}
              </span>
              <code>{line || " "}</code>
            </div>
          ))}
        </div>
      ) : (
        <div className="source-unavailable">
          <span className="source-icon" aria-hidden="true">
            &lt;/&gt;
          </span>
          <div>
            <strong>
              {original
                ? "Source text was not included"
                : runtimeFrame
                  ? "This frame belongs to the browser runtime"
                  : "Original source is not available for this frame"}
            </strong>
            <p className="muted">
              {original
                ? "The uploaded map restores the location but has no embedded source text."
                : runtimeFrame
                  ? "Built-in functions such as JSON.parse have no application source map. Select the next mapped frame to see where your code called them."
                  : anonymousFrame
                    ? "This frame has no file in the deployed build, so it cannot be mapped to application source. Select a mapped frame to inspect the caller."
                    : state === "failed"
                      ? "The source map could not be processed. Check the release artifacts and retry the upload."
                      : "Upload source maps for this exact application release and JavaScript file. Existing events will be processed automatically."}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
