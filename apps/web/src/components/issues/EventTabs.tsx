"use client";

import type { ReactNode } from "react";
import { Tabs } from "@base-ui/react/tabs";
import type { SafeBreadcrumb } from "@getexception/protocol";

export function EventTabs({
  events,
  breadcrumbs,
}: {
  events: ReactNode;
  breadcrumbs: SafeBreadcrumb[];
}) {
  return (
    <Tabs.Root defaultValue="events" className="panel event-tabs">
      <Tabs.List className="tabs-list" aria-label="Event information">
        <Tabs.Tab value="events">Events</Tabs.Tab>
        <Tabs.Tab value="breadcrumbs">
          Breadcrumbs <span className="count-badge">{breadcrumbs.length}</span>
        </Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="events">{events}</Tabs.Panel>
      <Tabs.Panel value="breadcrumbs">
        {breadcrumbs.length ? (
          <ol className="breadcrumbs-list">
            {breadcrumbs.map((crumb, index) => (
              <li key={index}>
                <span className="breadcrumb-dot" />
                <span className="mono muted">
                  {new Date(crumb.timestamp * 1000).toISOString().slice(11, 23)}
                </span>
                <span className="pill">{crumb.category}</span>
                <div>
                  <strong>
                    {crumb.data.operation ??
                      crumb.data.path ??
                      "Technical event"}
                  </strong>
                  <div className="muted small">
                    {[
                      crumb.data.method,
                      crumb.data.status_code,
                      crumb.data.duration === undefined
                        ? undefined
                        : `${crumb.data.duration} ms`,
                    ]
                      .filter((value) => value !== undefined)
                      .join(" · ")}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="empty-state">
            <h3>No breadcrumbs for this event</h3>
            <p>
              Safe technical breadcrumbs will appear here when the application
              includes them.
            </p>
          </div>
        )}
      </Tabs.Panel>
    </Tabs.Root>
  );
}
