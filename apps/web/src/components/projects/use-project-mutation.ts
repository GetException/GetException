"use client";

import { useState } from "react";
import { RequestError, requestMutation } from "../forms/utils";

export function useProjectMutation() {
  const [needsConfirmation, setNeedsConfirmation] = useState(false);

  async function run(
    path: string,
    value: unknown,
    method: "POST" | "PATCH" | "DELETE",
  ) {
    try {
      return await requestMutation(path, value, method);
    } catch (error) {
      if (error instanceof RequestError && error.status === 428) {
        setNeedsConfirmation(true);

        throw new Error(
          "Confirm your identity below, then submit again. Your changes are still here.",
        );
      }

      throw error;
    }
  }

  return {
    run,
    needsConfirmation,
    confirmed: () => setNeedsConfirmation(false),
  };
}
