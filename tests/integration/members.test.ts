import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase, type Database } from "@getexception/db";
import { temporaryDatabase } from "./database";
import { AuthService } from "../../apps/web/src/server/auth-service";
import { createRuntime } from "../../apps/web/src/server/runtime";
import { digest, token, totp } from "../../apps/web/src/server/crypto";
import { InvitationService } from "../../apps/web/src/server/invitations/service";
import { saveMember, saveTeam } from "../../apps/web/src/server/members";
import { MfaService } from "../../apps/web/src/server/mfa";
import { projectScope, teamScope } from "../../apps/web/src/server/access";
import { changeIssueStatus } from "../../apps/web/src/server/issue-workflow";
import { createProject } from "../../apps/web/src/server/projects";

let instance: Awaited<ReturnType<typeof temporaryDatabase>>;
let web: Database;
let service: AuthService;
let invitations: InvitationService;
let ownerHeaders: Headers;
let ownerId: string;
let organizationId: string;
let teamIds: string[];
const ownerEmail = "owner@example.test";
const password = token();
const period = () => BigInt(Math.floor(Date.now() / 30_000));

async function loginRequest(
  email: string,
  factor: { code?: string; recoveryCode?: string } = {},
) {
  const runtime = createRuntime(service.config, web);
  const response = await runtime.auth.handler(
    new Request(service.config.DASHBOARD_ORIGIN + "/api/auth/owner/login", {
      method: "POST",
      headers: {
        Origin: service.config.DASHBOARD_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password, trustDevice: false, ...factor }),
    }),
  );

  expect(response.status).toBe(200);

  return {
    body: await response.json(),
    headers: new Headers({
      Cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    }),
  };
}

async function login(
  email: string,
  factor: { code?: string; recoveryCode?: string } = {},
) {
  return (await loginRequest(email, factor)).headers;
}

async function invite(
  email: string,
  role: "developer" | "viewer" = "developer",
  teams = teamIds,
) {
  const result = await invitations.create(ownerHeaders, {
    email,
    role,
    teamIds: teams,
  });

  return { id: result.id, value: result.token };
}

async function register(invitation: { value: string }, name: string) {
  const enrollment = await invitations.beginRegistration(
    invitation.value,
    { name, password },
    randomUUID(),
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());

  try {
    const result = await invitations.finishRegistration(
      enrollment.enrollmentToken,
      { code: totp(enrollment.secret, period() - 1n) },
      randomUUID(),
    );

    return { ...enrollment, ...result };
  } finally {
    clock.mockRestore();
  }
}

async function participant(
  email: string,
  role: "developer" | "viewer" = "developer",
  teams = teamIds,
) {
  const invitation = await invite(email, role, teams);
  const enrollment = await register(invitation, email.split("@")[0]!);
  const headers = await login(email, {
    code: totp(enrollment.secret, period()),
  });
  const current = await service.authorize(headers);

  return { ...current, headers, invitation, enrollment };
}

beforeAll(async () => {
  instance = await temporaryDatabase();
  web = createDatabase(instance.urls.web);
  service = new AuthService(web, {
    DATABASE_URL: instance.urls.web,
    DASHBOARD_ORIGIN: "https://monitor.localhost",
    INGEST_ORIGIN: "https://ingest.monitor.localhost",
    BETTER_AUTH_SECRET: token(),
    TOTP_ENCRYPTION_KEY: token(),
    AUTH_RATE_KEY: token(),
  });
  invitations = new InvitationService(service);
});

beforeEach(async () => {
  await instance.admin.organization.deleteMany();
  await instance.admin.user.deleteMany();
  await instance.admin.systemSetting.deleteMany();
  await instance.admin.bootstrapToken.deleteMany();
  await instance.admin.setupSession.deleteMany();
  await instance.admin.auditLog.deleteMany();
  await instance.admin.authRateBucket.deleteMany();
  const bootstrap = token();

  await web.bootstrapToken.create({
    data: {
      tokenHash: digest(bootstrap),
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const access = await service.setupAccess(bootstrap, "setup");
  const prepared = await service.prepareSetup(
    access,
    { email: ownerEmail, password, domain: "monitor.localhost" },
    "setup",
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());

  try {
    await service.finishSetup(
      access,
      totp(prepared.secret, period() - 1n),
      "setup",
    );
  } finally {
    clock.mockRestore();
  }

  ownerHeaders = await login(ownerEmail, {
    code: totp(prepared.secret, period()),
  });
  const current = await service.authorize(ownerHeaders, true);

  ownerId = current.member.id;
  organizationId = current.member.organizationId;
  teamIds = [
    (
      await saveTeam(service, ownerHeaders, undefined, {
        name: "Frontend",
        memberIds: [],
        projectIds: [],
      })
    ).id,
    (
      await saveTeam(service, ownerHeaders, undefined, {
        name: "Backend",
        memberIds: [],
        projectIds: [],
      })
    ).id,
  ];
});

afterAll(async () => {
  await web?.$disconnect();
  await instance?.cleanup();
});

describe("manual invitations", () => {
  it("works without SMTP and creates the account only after the first TOTP code", async () => {
    const invitation = await invite("developer@example.test");
    const preview = await invitations.preview(invitation.value);

    expect(preview).toMatchObject({
      email: "d***@example.test",
      role: "developer",
      teams: expect.arrayContaining(["Frontend", "Backend"]),
    });
    expect(await web.user.count()).toBe(1);
    expect(await web.member.count()).toBe(1);

    const enrollment = await invitations.beginRegistration(
      invitation.value,
      { name: "Developer", password },
      "browser",
    );

    expect(await web.user.count()).toBe(1);
    expect(await web.member.count()).toBe(1);
    expect(
      await web.invitationEnrollment.findUnique({
        where: { invitationId: invitation.id },
      }),
    ).toMatchObject({ name: "Developer" });
    await expect(
      invitations.finishRegistration(
        enrollment.enrollmentToken,
        { code: "000000" },
        "bad-code",
      ),
    ).rejects.toThrow();

    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const results = await Promise.allSettled([
      invitations.finishRegistration(
        enrollment.enrollmentToken,
        { code: totp(enrollment.secret, period() - 1n) },
        "browser-a",
      ),
      invitations.finishRegistration(
        enrollment.enrollmentToken,
        { code: totp(enrollment.secret, period() - 1n) },
        "browser-b",
      ),
    ]);

    clock.mockRestore();
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await web.user.count()).toBe(2);
    expect(await web.member.count()).toBe(2);
    expect(await web.invitationEnrollment.count()).toBe(0);
    const member = await web.member.findFirstOrThrow({
      where: { user: { email: "developer@example.test" } },
      include: { teams: true, user: true },
    });

    expect(member.role).toBe("developer");
    expect(member.user.twoFactorEnabled).toBe(true);
    expect(member.teams.map((team) => team.teamId).sort()).toEqual(
      [...teamIds].sort(),
    );
    await expect(
      service.login(
        {
          email: "developer@example.test",
          password,
          trustDevice: false,
        },
        "missing-factor",
      ),
    ).rejects.toThrow();
    await expect(invitations.preview(invitation.value)).rejects.toMatchObject({
      status: 410,
    });
  });

  it("starts an authenticated session when a new account finishes registration", async () => {
    const invitation = await invite("signed-in@example.test");
    const enrollment = await invitations.beginRegistration(
      invitation.value,
      { name: "Signed in", password },
      "browser",
    );
    const runtime = createRuntime(service.config, web);
    const response = await runtime.auth.handler(
      new Request(
        service.config.DASHBOARD_ORIGIN +
          "/api/auth/invitation/finish-registration",
        {
          method: "POST",
          headers: {
            Origin: service.config.DASHBOARD_ORIGIN,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            enrollment: enrollment.enrollmentToken,
            code: totp(enrollment.secret, period()),
          }),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      recoveryCodes: expect.any(Array),
    });
    const responseCookies = response.headers.getSetCookie();
    const sessionCookie = responseCookies.find((value) =>
      value.startsWith("__Secure-__Host-getexception.session="),
    );

    expect(
      responseCookies.map((value) => value.slice(0, value.indexOf("="))),
    ).toContain("__Secure-__Host-getexception.session");
    await expect(
      service.authorize(new Headers({ Cookie: sessionCookie!.split(";")[0]! })),
    ).resolves.toMatchObject({ member: { role: "developer" } });
  });

  it("reissues one-time links, invalidates pending enrollment and revokes access", async () => {
    const invitation = await invite("viewer@example.test", "viewer");
    const enrollment = await invitations.beginRegistration(
      invitation.value,
      { name: "Viewer", password },
      "browser",
    );

    await expect(invite("VIEWER@example.test", "viewer")).rejects.toMatchObject(
      { status: 409, reason: "invitation_pending" },
    );
    const replacement = await invitations.change(
      ownerHeaders,
      invitation.id,
      "reissue",
    );

    expect("token" in replacement && replacement.token).not.toBe(
      invitation.value,
    );
    await expect(
      invitations.finishRegistration(
        enrollment.enrollmentToken,
        { code: totp(enrollment.secret, period()) },
        "stale",
      ),
    ).rejects.toMatchObject({ status: 410 });
    await expect(invitations.preview(invitation.value)).rejects.toMatchObject({
      status: 410,
    });

    const tokenValue =
      ("token" in replacement ? replacement.token : undefined) ?? "";

    await expect(invitations.preview(tokenValue)).resolves.toBeDefined();
    await invitations.change(ownerHeaders, invitation.id, "revoke");
    await expect(invitations.preview(tokenValue)).rejects.toMatchObject({
      status: 410,
    });
  });

  it("accepts an invitation only for a matching authenticated account", async () => {
    const invited = await participant("existing@example.test", "viewer");

    await expect(invite("existing@example.test")).rejects.toMatchObject({
      status: 409,
      reason: "member_exists",
    });
    await instance.admin.member.delete({ where: { id: invited.member.id } });
    const invitation = await invite("existing@example.test", "developer", [
      teamIds[0]!,
    ]);

    await expect(
      invitations.accept(ownerHeaders, invitation.value),
    ).rejects.toMatchObject({ status: 403, reason: "invitation_email" });
    await invitations.accept(invited.headers, invitation.value);
    const current = await service.authorize(invited.headers);

    expect(current.member.role).toBe("developer");
    const duplicate = await invite("other@example.test", "viewer");

    await web.invitation.update({
      where: { id: duplicate.id },
      data: { email: "existing@example.test" },
    });
    await expect(
      invitations.accept(invited.headers, duplicate.value),
    ).rejects.toMatchObject({ status: 409, reason: "member_exists" });
  });

  it("rejects expired invitations and enrollment after revocation", async () => {
    const invitation = await invite("expired@example.test");
    const enrollment = await invitations.beginRegistration(
      invitation.value,
      { name: "Expired", password },
      "browser",
    );

    await invitations.change(ownerHeaders, invitation.id, "revoke");
    await expect(
      invitations.finishRegistration(
        enrollment.enrollmentToken,
        { code: totp(enrollment.secret, period()) },
        "late",
      ),
    ).rejects.toMatchObject({ status: 410 });
    const expired = await invite("expired@example.test");

    await web.invitation.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(0) },
    });
    await expect(invitations.preview(expired.value)).rejects.toMatchObject({
      status: 410,
    });
    const newest = await invite("expired@example.test");

    await expect(invitations.preview(newest.value)).resolves.toBeDefined();

    await web.invitation.update({
      where: { id: newest.id },
      data: { expiresAt: new Date(0) },
    });
    const replacement = await invitations.change(
      ownerHeaders,
      expired.id,
      "reissue",
    );
    const replacementToken =
      ("token" in replacement ? replacement.token : undefined) ?? "";

    await expect(invitations.preview(replacementToken)).resolves.toBeDefined();
    await expect(invitations.preview(newest.value)).rejects.toMatchObject({
      status: 410,
    });
  });
});

describe("server-side roles and mandatory MFA", () => {
  it("scopes Developer and Viewer access to teams and restricts mutations", async () => {
    const developer = await participant("developer@example.test", "developer", [
      teamIds[0]!,
    ]);
    const viewer = await participant("viewer@example.test", "viewer", [
      teamIds[0]!,
    ]);
    const projects = await Promise.all(
      teamIds.map((teamId, index) =>
        web.project.create({
          data: {
            organizationId,
            name: `Project ${index}`,
            slug: `project-${index}`,
            teams: { create: { teamId } },
          },
        }),
      ),
    );
    const issues = await Promise.all(
      projects.map((project) =>
        instance.admin.issue.create({
          data: {
            projectId: project.id,
            fingerprint: token(),
            title: "Access test",
            exceptionType: "Error",
            firstSeen: new Date(),
            lastSeen: new Date(),
            eventCount: 1,
          },
        }),
      ),
    );

    for (const member of [developer.member, viewer.member]) {
      expect(await web.project.count({ where: projectScope(member) })).toBe(1);
      expect(await web.team.count({ where: teamScope(member) })).toBe(1);
      expect(
        await web.issue.count({
          where: { id: issues[1]!.id, project: projectScope(member) },
        }),
      ).toBe(0);
    }

    await changeIssueStatus(service, developer.headers, issues[0]!.id, {
      status: "resolved",
      eventCount: 1,
    });
    await expect(
      changeIssueStatus(service, viewer.headers, issues[0]!.id, {
        status: "open",
        eventCount: 1,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      changeIssueStatus(service, developer.headers, issues[1]!.id, {
        status: "resolved",
        eventCount: 1,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createProject(service, developer.headers, {
        name: "Forbidden",
        slug: "forbidden",
        origins: ["https://app.example.test"],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      invitations.create(developer.headers, {
        email: "forbidden@example.test",
        role: "viewer",
        teamIds,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("revokes live sessions on access changes and permits reactivation", async () => {
    const developer = await participant("developer@example.test");

    await saveMember(service, ownerHeaders, developer.member.id, {
      role: "viewer",
      active: true,
      teamIds: [teamIds[0]!],
    });
    await expect(service.authorize(developer.headers)).rejects.toMatchObject({
      status: 401,
    });
    const refreshed = await login("developer@example.test", {
      recoveryCode: developer.enrollment.recoveryCodes[0],
    });

    expect((await service.authorize(refreshed)).member.role).toBe("viewer");
    await saveMember(service, ownerHeaders, developer.member.id, {
      role: "viewer",
      active: false,
      teamIds: [],
    });
    await expect(service.authorize(refreshed)).rejects.toMatchObject({
      status: 401,
    });
    await saveMember(service, ownerHeaders, developer.member.id, {
      role: "developer",
      active: true,
      teamIds,
    });
    const restored = await login("developer@example.test", {
      recoveryCode: developer.enrollment.recoveryCodes[1],
    });

    await expect(service.authorize(restored)).resolves.toBeDefined();
  });

  it("gives legacy accounts only a short setup session until TOTP is activated", async () => {
    const viewer = await participant("viewer@example.test", "viewer");

    await web.session.deleteMany({ where: { userId: viewer.user.id } });
    await web.mfaCredential.deleteMany({ where: { userId: viewer.user.id } });
    await web.recoveryCode.deleteMany({ where: { userId: viewer.user.id } });
    await web.user.update({
      where: { id: viewer.user.id },
      data: { twoFactorEnabled: false },
    });
    const enrollmentLogin = await loginRequest("viewer@example.test");

    expect(enrollmentLogin.body).toMatchObject({ enrollmentRequired: true });
    await expect(
      service.authorize(enrollmentLogin.headers),
    ).rejects.toMatchObject({ status: 401 });
    const mfa = new MfaService(service);
    const details = await mfa.details(enrollmentLogin.headers);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    let recoveryCodes: string[];

    try {
      recoveryCodes = (
        await mfa.finish(
          enrollmentLogin.headers,
          { code: totp(details.secret, period() - 1n) },
          "finish",
        )
      ).recoveryCodes;
    } finally {
      clock.mockRestore();
    }

    expect(recoveryCodes!).toHaveLength(10);
    await expect(
      service.authorize(enrollmentLogin.headers),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      service.authorize(
        await login("viewer@example.test", {
          code: totp(details.secret, period()),
        }),
      ),
    ).resolves.toMatchObject({ member: { role: "viewer" } });
  });

  it("requires recent TOTP and preserves one active Owner under concurrency", async () => {
    await expect(
      saveMember(service, ownerHeaders, ownerId, {
        role: "viewer",
        active: true,
        teamIds,
      }),
    ).rejects.toMatchObject({ reason: "last_owner" });
    const developer = await participant("developer@example.test");

    await saveMember(service, ownerHeaders, developer.member.id, {
      role: "owner",
      active: true,
      teamIds,
    });
    const promoted = await login("developer@example.test", {
      recoveryCode: developer.enrollment.recoveryCodes[0],
    });
    const results = await Promise.allSettled([
      saveMember(service, ownerHeaders, ownerId, {
        role: "developer",
        active: true,
        teamIds,
      }),
      saveMember(service, promoted, developer.member.id, {
        role: "developer",
        active: true,
        teamIds,
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await web.member.count({ where: { role: "owner", active: true } }),
    ).toBe(1);
  });
});
