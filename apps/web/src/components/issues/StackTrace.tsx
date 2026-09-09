"use client";

import { useState } from "react";
import { Button } from "@base-ui/react/button";
import type { SafeFrame } from "@getexception/protocol";

export function StackTrace({
  frames,
  release,
}: {
  frames: SafeFrame[];
  release?: string | null;
}) {
  const ordered = frames.slice().reverse();
  const [applicationOnly, setApplicationOnly] = useState(false);
  const [selected, setSelected] = useState(0);
  const chosen = ordered[selected];
  const visible = ordered
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => !applicationOnly || frame.in_app);

  return (
    <>
      <section className="panel stack-panel">
        <div className="section-heading">
          <div>
            <h2>Stack trace</h2>
            <p className="muted">
              {frames.length} frames ·{" "}
              {frames.filter((frame) => frame.in_app).length} application frames
            </p>
          </div>
          <Button
            className="button compact"
            aria-pressed={applicationOnly}
            onClick={() => {
              if (!applicationOnly && chosen && !chosen.in_app) {
                const first = ordered.findIndex((frame) => frame.in_app);

                if (first >= 0) {
                  setSelected(first);
                }
              }

              setApplicationOnly(!applicationOnly);
            }}
          >
            Application frames
          </Button>
        </div>
        <div className="stack">
          {visible.length ? (
            visible.map(({ frame, index }) => (
              <button
                type="button"
                className={`stack-frame ${selected === index ? "selected" : ""} ${frame.in_app ? "application-frame" : ""}`}
                key={index}
                aria-pressed={selected === index}
                onClick={() => setSelected(index)}
              >
                <span className="frame-dot" />
                <span className="frame-function mono">
                  {frame.function || "<anonymous>"}
                </span>
                <span className="frame-file mono" title={frame.filename}>
                  {frame.filename}
                </span>
                <span className="frame-line mono">
                  {frame.lineno}:{frame.colno}
                </span>
              </button>
            ))
          ) : (
            <p className="content-note">
              {frames.length
                ? "No application frames in this event. Show all frames to inspect the stack."
                : "No stack trace was included with this event."}
            </p>
          )}
        </div>
      </section>
      <section className="panel source-panel">
        <div className="section-heading">
          <h2>Source context</h2>
          <span className="pill">Source map unavailable</span>
        </div>
        {chosen && (
          <div className="source-location mono">
            <span>{chosen.filename}</span>
            <span className="muted">
              Line {chosen.lineno} · column {chosen.colno}
            </span>
          </div>
        )}
        <div className="source-unavailable">
          <span className="source-icon" aria-hidden="true">
            &lt;/&gt;
          </span>
          <div>
            <strong>Original source is not available</strong>
            <p className="muted">
              {release
                ? "This release has no source map available. The stack above shows the compiled application frames."
                : "This event has no release or source map attached. You can inspect the captured stack above."}
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
