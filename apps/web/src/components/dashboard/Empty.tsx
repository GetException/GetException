import type { ReactNode } from "react";

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span aria-hidden="true">⌁</span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
