import { describe, expect, it } from "vitest";
import { issueFilters, issueWhere } from "../../apps/web/src/server/filters";
import { linkTo, pageNumber } from "../../apps/web/src/lib/search-params";

describe("dashboard query boundaries", () => {
  it("bounds hostile query input and falls back for unsupported filters", () => {
    expect(
      issueFilters({
        q: "x".repeat(500),
        status: "deleted",
        sort: "password",
        environment: ["production", "staging"],
        page: "99999999",
        period: "forever",
      }),
    ).toMatchObject({
      q: "x".repeat(160),
      status: "all",
      sort: "recent",
      environment: "all",
      page: 200,
      period: "all",
    });
    expect(pageNumber("-5")).toBe(1);
    expect(pageNumber("2.5")).toBe(1);
    expect(pageNumber(["1", "999"])).toBe(1);
  });
  it("keeps workspace scope when a project is supplied and matches environment and release on the same event", () => {
    const filters = issueFilters({
      project: "foreign-project",
      release: "checkout@0123456789abcdef",
      environment: "production",
      status: "regression",
      period: "7d",
    });

    expect(
      issueWhere(
        { id: "member", role: "owner", organizationId: "current-workspace" },
        filters,
        7 * 86400_000,
      ),
    ).toEqual({
      project: { organizationId: "current-workspace", id: "foreign-project" },
      status: "open",
      regression: true,
      lastSeen: { gte: new Date(0) },
      events: {
        some: {
          environment: "production",
          release: "checkout@0123456789abcdef",
        },
      },
    });
  });
  it("round-trips punctuation in search and release links without introducing query keys", () => {
    const q = "TypeError & status=resolved / <script>";
    const url = new URL(
      linkTo("/issues", { q, status: "all", release: "checkout@abc", page: 2 }),
      "https://monitor.example.test",
    );

    expect(url.pathname).toBe("/issues");
    expect(url.searchParams.get("q")).toBe(q);
    expect(url.searchParams.has("status")).toBe(false);
    expect(url.searchParams.get("release")).toBe("checkout@abc");
    expect(url.searchParams.get("page")).toBe("2");
  });
});
