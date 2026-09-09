"use client";

import { useEffect, useState } from "react";

export function useFragmentToken() {
  const [token, setToken] = useState<string>();

  useEffect(() => {
    const value = window.location.hash.slice(1);

    if (value) {
      window.history.replaceState(null, "", window.location.pathname);
      setToken(value);
    } else {
      setToken((current) => current ?? "");
    }
  }, []);

  return token;
}
