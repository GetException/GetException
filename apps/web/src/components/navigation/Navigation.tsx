"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { destinations } from "./constants";
import { matchesDestination } from "./utils";

export function Navigation({ role }: { role: string }) {
  const path = usePathname();

  return (
    <nav aria-label="Main navigation">
      {destinations
        .filter((item) => !item.ownerOnly || role === "owner")
        .map((item) => {
          const active = matchesDestination(path, item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className="nav-item"
              aria-current={active ? "page" : undefined}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={item.icon} />
              </svg>
              {item.label}
            </Link>
          );
        })}
    </nav>
  );
}
