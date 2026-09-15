export function projectFormValues(data: FormData) {
  return {
    name: data.get("name"),
    slug: data.get("slug"),
    origins: String(data.get("origins") ?? "")
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}
