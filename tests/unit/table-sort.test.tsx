import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SortableTableHead } from "../../apps/web/src/components/dashboard/SortableTableHead";
import { Pagination } from "../../apps/web/src/components/dashboard/Pagination";
import { tableSort, sortValues } from "../../apps/web/src/lib/table-sort";

function hrefs(html: string) {
  return [...html.matchAll(/href="([^"]+)"/g)].map(
    (match) =>
      new URL(
        match[1]!.replaceAll("&amp;", "&"),
        "https://monitor.example.test",
      ),
  );
}

describe("table sorting navigation", () => {
  it("rejects unknown and array-valued keys and preserves old issue sort links", () => {
    expect(
      tableSort(
        { sort: "__proto__", direction: "desc; drop table project" },
        "issues",
      ),
    ).toEqual({ sort: "recent", direction: "desc" });
    expect(
      tableSort({ sort: ["events"], direction: ["asc"] }, "members"),
    ).toEqual({ sort: "joined", direction: "asc" });
    expect(tableSort({ sort: "events" }, "issues")).toEqual({
      sort: "events",
      direction: "desc",
    });
    expect(tableSort({ sort: "first", direction: "asc" }, "issues")).toEqual({
      sort: "first",
      direction: "asc",
    });
  });

  it("toggles the active column and resets only its page while keeping filters", () => {
    const html = renderToStaticMarkup(
      <table>
        <SortableTableHead
          table="releases"
          sorting={{ sort: "events", direction: "desc" }}
          path="/releases"
          values={{
            page: 4,
            project: "account",
            environment: "staging",
            review: "gitlab:7:554",
            maps: "ready",
            q: "x & page=9",
          }}
        />
      </table>,
    );
    const links = hrefs(html);
    const events = links.find(
      (url) => url.searchParams.get("sort") === "events",
    )!;
    const version = links.find(
      (url) => url.searchParams.get("sort") === "version",
    )!;

    expect(links).toHaveLength(6);
    expect(Object.fromEntries(events.searchParams)).toEqual({
      page: "1",
      project: "account",
      environment: "staging",
      review: "gitlab:7:554",
      maps: "ready",
      q: "x & page=9",
      sort: "events",
      direction: "asc",
    });
    expect(version.searchParams.get("direction")).toBe("asc");
    expect(html.match(/aria-sort=/g)).toHaveLength(1);
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('scope="col"');
    expect(html).toContain('aria-label="Events: sort ascending"');
  });

  it("keeps members and invitations independent, including next-page links", () => {
    const sorting = tableSort(
      { inviteSort: "role", inviteDirection: "asc" },
      "invitations",
      "invite",
    );
    const values = {
      q: "Alex",
      sort: "joined",
      direction: "desc",
      page: 3,
      invitePage: 2,
      ...sortValues(sorting, "invite"),
    };
    const html = renderToStaticMarkup(
      <table>
        <SortableTableHead
          table="invitations"
          sorting={sorting}
          path="/members"
          values={values}
          prefix="invite"
        >
          <th>Actions</th>
        </SortableTableHead>
      </table>,
    );
    const role = hrefs(html).find(
      (url) => url.searchParams.get("inviteSort") === "role",
    )!;

    expect(Object.fromEntries(role.searchParams)).toEqual({
      ...values,
      page: "3",
      invitePage: "1",
      inviteDirection: "desc",
    });
    const pagination = renderToStaticMarkup(
      <Pagination
        path="/members"
        values={values}
        page={2}
        total={70}
        pageParam="invitePage"
      />,
    );

    expect(
      hrefs(pagination).map((url) => [
        url.searchParams.get("page"),
        url.searchParams.get("invitePage"),
        url.searchParams.get("inviteSort"),
      ]),
    ).toEqual([
      ["3", "1", "role"],
      ["3", "3", "role"],
    ]);
  });
});
