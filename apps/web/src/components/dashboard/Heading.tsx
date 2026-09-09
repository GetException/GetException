import type { ReactNode } from "react";

export function Heading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">WORKSPACE / ERROR MONITORING</span>
        <h1>
          {title}
          <span className="heading-dot">.</span>
        </h1>
        <p className="muted">{description}</p>
      </div>
      {action}
    </div>
  );
}
