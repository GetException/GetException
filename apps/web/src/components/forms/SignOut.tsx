"use client";

import { post } from "./utils";
import { useRouter } from "next/navigation";
import { Button } from "@base-ui/react/button";

export function SignOut() {
  const router = useRouter();

  return (
    <Button
      className="text-button"
      onClick={async () => {
        await post("/api/auth/sign-out", {});
        router.push("/login");
        router.refresh();
      }}
    >
      Sign out ↗
    </Button>
  );
}
