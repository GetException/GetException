"use client";

import { post } from "./utils";
import { useRouter } from "next/navigation";
import { Button } from "@base-ui/react/button";

export function SignOut() {
  const router = useRouter();

  return (
    <Button
      type="button"
      className="button sign-out-button"
      aria-label="Sign out"
      title="Sign out"
      onClick={async () => {
        await post("/api/auth/sign-out", {});
        router.push("/login");
        router.refresh();
      }}
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
        <path d="M9 5H5v14h4M17 8l4 4-4 4M9 12h12" />
      </svg>
      <span className="sign-out-label">Sign out</span>
    </Button>
  );
}
