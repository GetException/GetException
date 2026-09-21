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
  const [mappedOnly, setMappedOnly] = useState(false);
  const [selected, setSelected] = useState(() => {
    const firstMapped = ordered.findIndex((_, index) => Boolean(mapped[index]));

    return firstMapped < 0 ? 0 : firstMapped;
  });
  const chosen = ordered[selected];
  const visible = ordered
    .map((frame, index) => ({ frame, index }))
    .filter(({ index }) => !mappedOnly || Boolean(mapped[index]));
  const mappedCount = mapped.filter(Boolean).length;

  return (
    <>
      <section className="panel stack-panel">
        <div className="section-heading">
          <div>
            <h2>Stack trace</h2>
            <p className="muted">
              {frames.length} frames · {mappedCount} with original locations
            </p>
          </div>
          <Button
            className="button compact"
            aria-pressed={mappedOnly}
            disabled={mappedCount === 0}
            onClick={() => setMappedOnly(!mappedOnly)}
          >
            Mapped frames
          </Button>
        </div>
        <div className="stack">
          {visible.length ? (
            visible.map(({ frame, index }) => {
              const original = mapped[index];
              const functionName =
                original?.function || frame.function || "<anonymous>";
              const shortName = Boolean(
                original && /^[\w$]{1,2}$/.test(functionName),
              );
              const filename = original?.filename ?? frame.filename;
              const title = shortName
                ? filename.split("/").at(-1) || filename
                : functionName;

              return (
                <button
                  type="button"
                  className={`stack-frame ${selected === index ? "selected" : ""} ${original ? "mapped-frame" : ""}`}
                  key={index}
                  aria-pressed={selected === index}
                  onClick={() => setSelected(index)}
                >
                  <span className="frame-dot" />
                  <span className="frame-function mono" title={functionName}>
                    <span>{title}</span>
                    <span className="frame-kind">
                      {original
                        ? shortName
                          ? `Original location · function ${functionName}`
                          : "Original location"
                        : frame.lineno === 0 &&
                            frame.filename.includes("<anonymous>")
                          ? "Browser runtime"
                          : "Compiled frame"}
                    </span>
                  </span>
                  <span className="frame-file mono" title={filename}>
                    {filename}
                  </span>
                  <span className="frame-line mono">
                    {original?.lineno ?? frame.lineno}:
                    {original?.colno ?? frame.colno}
                  </span>
                </button>
              );
            })
          ) : (
            <p className="content-note">
              {frames.length
                ? "No frames in this event have an original source location."
                : "No stack trace was included with this event."}
            </p>
          )}
        </div>
      </section>
      <SourceContext frame={chosen} original={mapped[selected]} state={state} />
    </>
  );
}
