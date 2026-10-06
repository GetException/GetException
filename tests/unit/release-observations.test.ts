import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  appVersionSchema,
  sanitizeAppVersion,
  releaseRegistrationSchema,
} from "../../packages/protocol/src/releases";
import {
  encodeEnvelope,
  sanitizeEvent,
} from "../../packages/protocol/src/index";
import { issueFilters, issueWhere } from "../../apps/web/src/server/filters";
import { releaseLabel } from "../../apps/web/src/lib/format";
import { NewInRelease } from "../../apps/web/src/components/issues/NewInRelease";
import { IssueReleaseHistory } from "../../apps/web/src/components/issues/IssueReleaseHistory";

const release = `account@${"a".repeat(40)}`;

it("accepts bounded SemVer and drops invalid version metadata without dropping an error", () => {
  for (const version of ["3.192.75", "0.0.0", "3.192.75-beta.2+build.42"]) {
    expect(appVersionSchema.parse(version)).toBe(version);
    const safe = sanitizeEvent(
      {
        message: "Error",
        release,
        contexts: { app: { route: "/settings", version, secret: "private" } },
      },
      "a".repeat(32),
    );

    expect(safe.appVersion).toBe(version);
    const raw = JSON.parse(encodeEnvelope(safe).split("\n")[2]!);

    expect(raw.contexts.app).toEqual({ route: "/settings", version });
    expect(sanitizeEvent(raw, "a".repeat(32)).appVersion).toBe(version);
    expect(
      releaseRegistrationSchema.parse({
        release,
        appVersion: version,
        deployment: { environment: "production" },
      }).appVersion,
    ).toBe(version);
  }

  for (const version of [
    "01.2.3",
    "1.2",
    "1.2.3-01",
    "https://private.example.test",
    "<script>",
    "1.2.3+" + "a".repeat(64),
    "1.2.3\n",
    { version: "1.2.3" },
  ]) {
    expect(sanitizeAppVersion(version)).toBeUndefined();
    expect(
      sanitizeEvent(
        { message: "Preserved", contexts: { app: { version } } },
        "a".repeat(32),
      ),
    ).toMatchObject({ message: "Preserved", frames: [] });
    expect(
      releaseRegistrationSchema.safeParse({
        release,
        appVersion: version,
        deployment: { environment: "production" },
      }).success,
    ).toBe(false);
  }
});

it("requires a selected release for new-issue filtering and keeps history in the authorized project scope", () => {
  const member = { id: "viewer", organizationId: "workspace", role: "viewer" };
  const filters = issueFilters({
    project: "foreign",
    environment: "production",
    release,
    novelty: "new",
  });
  const where = issueWhere(member, filters, new Date("2026-10-06").getTime());

  expect(where).toMatchObject({
    project: {
      id: "foreign",
      organizationId: "workspace",
      teams: { some: { team: { members: { some: { memberId: "viewer" } } } } },
    },
    AND: [
      {
        OR: [
          {
            histories: {
              some: {
                canonical: true,
                firstSeenKnown: true,
                firstRelease: release,
                environment: "production",
              },
            },
            events: { some: { release, environment: "production" } },
          },
        ],
      },
    ],
  });
  expect(issueFilters({ novelty: "new" }).novelty).toBe("all");
  expect(issueFilters({ release, novelty: "<script>" }).novelty).toBe("all");
});

it("shows app versions with fallback and distinguishes incomplete history from a missing release", () => {
  expect(releaseLabel(release, "3.192.75")).toBe("3.192.75");
  expect(releaseLabel(release)).toBe("aaaaaaaa");
  expect(
    renderToStaticMarkup(
      createElement(NewInRelease, { release, appVersion: "3.192.75" }),
    ),
  ).toContain("New in 3.192.75");
  const observation = {
    environment: "production",
    firstSeen: new Date("2026-10-01"),
    lastSeen: new Date("2026-10-06"),
    firstRelease: release,
    lastRelease: release,
    firstAppVersion: null,
    lastAppVersion: null,
    firstSeenKnown: true,
  };
  const releases = [{ id: "release", name: release, appVersion: "3.192.75" }];
  const html = renderToStaticMarkup(
    createElement(IssueReleaseHistory, {
      observations: [observation],
      releases,
    }),
  );

  expect(html).toContain("3.192.75");
  expect(html).toContain("environment=production");
  expect(
    renderToStaticMarkup(
      createElement(IssueReleaseHistory, {
        observations: [{ ...observation, firstSeenKnown: false }],
        releases,
      }),
    ),
  ).toContain("Earlier history unavailable");
  expect(
    renderToStaticMarkup(
      createElement(IssueReleaseHistory, {
        observations: [{ ...observation, firstRelease: null }],
        releases,
      }),
    ),
  ).toContain("Release not reported");
});
