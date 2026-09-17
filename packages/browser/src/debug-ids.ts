/** Only attach the identity of the exact loaded script; never send the registry. */
export function scriptDebugId(
  filename: string | undefined,
): string | undefined {
  if (!filename) {
    return undefined;
  }

  const registry = Object.getOwnPropertyDescriptor(
    globalThis,
    "__GETEXCEPTION_DEBUG_IDS__",
  )?.value;
  const value =
    registry && typeof registry === "object"
      ? Object.getOwnPropertyDescriptor(registry, filename)?.value
      : undefined;

  return typeof value === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
    ? value
    : undefined;
}
