export function matchesDestination(path: string, href: string) {
  return href === "/"
    ? path === "/"
    : path === href ||
        path.startsWith(href + "/") ||
        (href === "/settings" && path === "/security");
}
