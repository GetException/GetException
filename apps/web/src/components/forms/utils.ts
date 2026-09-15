export async function post(path: string, value: unknown) {
  return requestMutation(path, value, "POST");
}

export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function requestMutation(
  path: string,
  value: unknown,
  method: "POST" | "PATCH" | "DELETE",
) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
    credentials: "same-origin",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  const data = await response.json();

  if (!response.ok) {
    throw new RequestError(
      response.status,
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
