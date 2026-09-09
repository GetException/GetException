export const dateTime = (value: Date) =>
  value.toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }) + " UTC";

export const number = (value: number) => value.toLocaleString("en-US");

export function releaseLabel(value: string) {
  const parts = value.split("@");

  return parts.length === 2 ? parts[1]!.slice(0, 8) : value;
}
