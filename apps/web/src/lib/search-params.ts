import { MAX_PAGE } from "./pagination";

export type Search = Record<string, string | string[] | undefined>;

export function textParam(value: string | string[] | undefined, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function pageNumber(value: string | string[] | undefined) {
  const text = textParam(value, 8);

  return /^\d+$/.test(text) ? Math.max(1, Math.min(MAX_PAGE, Number(text))) : 1;
}

export function linkTo(
  path: string,
  values: Record<string, string | number | undefined>,
) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "" && value !== "all") {
      query.set(key, String(value));
    }
  }

  return path + (query.size ? `?${query}` : "");
}
