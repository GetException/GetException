"use client";

import { useState } from "react";
import { Button } from "@base-ui/react/button";
import { SourceContext } from "./SourceContext";
import type { SafeFrame, OriginalFrame } from "@getexception/protocol";

export function StackTrace({
  frames,
  originals = [],
  state,
}: {
  frames: SafeFrame[];
  originals?: (OriginalFrame | null)[];
  state?: string;
}) {
  const ordered = frames.slice().reverse();
  const mapped = originals.slice().reverse();
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
                  {mapped[index]?.function || frame.function || "<anonymous>"}
                </span>
                <span
                  className="frame-file mono"
                  title={mapped[index]?.filename ?? frame.filename}
                >
                  {mapped[index]?.filename ?? frame.filename}
                </span>
                <span className="frame-line mono">
                  {mapped[index]?.lineno ?? frame.lineno}:
                  {mapped[index]?.colno ?? frame.colno}
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
      <SourceContext frame={chosen} original={mapped[selected]} state={state} />
    </>
  );
}
