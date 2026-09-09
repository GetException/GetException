export async function post(path: string, value: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
    credentials: "same-origin",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      response.status === 428
        ? "Please confirm your password and a new code in Settings, then try again."
        : response.status === 429
          ? "Too many attempts. Try again in five minutes."
          : typeof data.error === "string"
            ? data.error
            : "Unable to complete the request. Check your details and try again.",
    );
  }

  return data;
}
