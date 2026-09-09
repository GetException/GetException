"use client";

import { usePathname } from "next/navigation";
import { destinations } from "./constants";
import { matchesDestination } from "./utils";

export function Location() {
  const path = usePathname();
  const current = destinations.find(
    (item) => item.href !== "/" && matchesDestination(path, item.href),
  );

  return (
    <span>
      Workspace <span className="muted">/</span> {current?.label ?? "Overview"}
    </span>
  );
}
