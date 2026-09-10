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
import { openMail } from "@getexception/mail";
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
import {
  claimMail,
  deliverMail,
  retryMail,
  runMail,
} from "../../apps/worker/src/mail/queue";

let instance: Awaited<ReturnType<typeof temporaryDatabase>>;
let web: Database,
  mail: Database,
  service: AuthService,
  invitations: InvitationService;
let ownerHeaders: Headers,
  ownerId: string,
  organizationId: string,
  teamIds: string[];
const ownerEmail = "owner@example.test";
const password = token();
const period = () => BigInt(Math.floor(Date.now() / 30_000));

async function login(
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

  return new Headers({
    Cookie: response.headers.get("set-cookie")!.split(";")[0]!,
  });
}

async function mailToken(id: string, kind = "invitation") {
  const job = await web.mailOutbox.findUniqueOrThrow({
    where: { invitationId_kind: { invitationId: id, kind } },
  });
  const payload = openMail(
    job.payload!,
    job.id,
    job.revision,
    service.config.MAIL_ENCRYPTION_KEY,
  );
  const value = /#([a-f0-9]{64})/.exec(payload.text)?.[1];

  if (!value) {
    throw new Error("Test invitation link missing");
  }

  return value;
}

async function invite(
  email: string,
  role: "developer" | "viewer" = "developer",
  teams = teamIds,
) {
  const { id } = await invitations.create(ownerHeaders, {
    email,
    role,
    teamIds: teams,
  });

  return { id, value: await mailToken(id) };
}

async function verified(id: string, value: string) {
  await invitations.requestVerification(value, randomUUID());

  return invitations.verifyEmail(
    await mailToken(id, "verification"),
    randomUUID(),
  );
}

async function participant(
  email: string,
  role: "developer" | "viewer" = "developer",
  teams = teamIds,
) {
  const invitation = await invite(email, role, teams);
  const registration = await verified(invitation.id, invitation.value);

  await invitations.register(
    registration,
    { name: email.split("@")[0], password },
    randomUUID(),
  );
  const headers = await login(email);
  const current = await service.authorize(headers);

  return { ...current, headers, invitation };
}

beforeAll(async () => {
  instance = await temporaryDatabase();
  web = createDatabase(instance.urls.web);
  mail = createDatabase(instance.urls.mail);
  service = new AuthService(web, {
    DATABASE_URL: instance.urls.web,
    DASHBOARD_ORIGIN: "https://monitor.localhost",
    INGEST_ORIGIN: "https://ingest.monitor.localhost",
    BETTER_AUTH_SECRET: token(),
    TOTP_ENCRYPTION_KEY: token(),
    AUTH_RATE_KEY: token(),
    MAIL_ENCRYPTION_KEY: token(),
    MAIL_ENABLED: true,
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
    ownerHeaders = await login(ownerEmail, {
      code: totp(prepared.secret, period()),
    });
  } finally {
    clock.mockRestore();
  }

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
  await Promise.all([web?.$disconnect(), mail?.$disconnect()]);
  await instance?.cleanup();
});

describe("email-bound invitations", () => {
  it("keeps Owner access without email, blocks invitations without writes and permits revocation", async () => {
    const invitation = await invite("pending@example.test");
    const offline = new AuthService(web, {
      ...service.config,
      MAIL_ENABLED: false,
    });
    const paused = new InvitationService(offline);
    const before = await web.mailOutbox.findMany();
    const disabled = { status: 503, reason: "mail_disabled" };

    expect((await offline.authorize(ownerHeaders, true)).member.role).toBe(
      "owner",
    );
    await expect(
      paused.create(ownerHeaders, {
        email: "new@example.test",
        role: "viewer",
        teamIds,
      }),
    ).rejects.toMatchObject(disabled);
    await expect(
      paused.change(ownerHeaders, invitation.id, "resend"),
    ).rejects.toMatchObject(disabled);
    await expect(paused.preview(invitation.value)).rejects.toMatchObject(
      disabled,
    );
    await expect(
      paused.requestVerification(invitation.value, randomUUID()),
    ).rejects.toMatchObject(disabled);
    await expect(
      paused.verifyEmail(token(), randomUUID()),
    ).rejects.toMatchObject(disabled);
    await expect(paused.registrationDetails(token())).rejects.toMatchObject(
      disabled,
    );
    expect(await web.invitation.count()).toBe(1);
    expect(await web.invitationVerification.count()).toBe(0);
    expect(await web.mailOutbox.findMany()).toEqual(before);

    await paused.change(ownerHeaders, invitation.id, "revoke");
    expect(
      await web.invitation.findUniqueOrThrow({ where: { id: invitation.id } }),
    ).toMatchObject({ status: "revoked", tokenHash: null });
    expect(
      await web.mailOutbox.findUniqueOrThrow({ where: { id: before[0]!.id } }),
    ).toMatchObject({ status: "cancelled", payload: null });

    // Restoring delivery uses the same Owner, keys and database.
    await expect(invite("later@example.test")).resolves.toHaveProperty("id");
    expect(await web.user.count()).toBe(1);
  });

  it("requires separate email proof, masks public preview and atomically joins every invited team", async () => {
    const invitation = await invite("developer@example.test");
    const preview = await invitations.preview(invitation.value);

    expect(preview).toMatchObject({
      email: "d***@example.test",
      role: "developer",
      teams: expect.arrayContaining(["Frontend", "Backend"]),
    });
    expect("existingAccount" in preview).toBe(false);
    await expect(
      invitations.register(
        invitation.value,
        { name: "Attacker", password },
        "attacker",
      ),
    ).rejects.toMatchObject({ status: 410 });
    expect(await web.user.count()).toBe(1);
    const proof = await verified(invitation.id, invitation.value);

    expect(await invitations.registrationDetails(proof)).toEqual({
      email: "developer@example.test",
      existingAccount: false,
    });
    await expect(
      invitations.register(
        proof,
        { name: "Developer", password, role: "owner" },
        "browser",
      ),
    ).rejects.toThrow();
    const results = await Promise.allSettled([
      invitations.register(proof, { name: "Developer", password }, "browser-a"),
      invitations.register(proof, { name: "Developer", password }, "browser-b"),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await web.user.count()).toBe(2);
    const member = await web.member.findFirstOrThrow({
      where: { user: { email: "developer@example.test" } },
      include: { teams: true },
    });

    expect(member.role).toBe("developer");
    expect(member.teams.map((team) => team.teamId).sort()).toEqual(
      [...teamIds].sort(),
    );
    expect(await web.invitationVerification.count()).toBe(0);
    expect(
      await web.mailOutbox.count({ where: { payload: { not: null } } }),
    ).toBe(0);
    await expect(
      service.authorize(await login("developer@example.test")),
    ).resolves.toMatchObject({
      member: { role: "developer" },
      session: { mfaMethod: "password" },
    });
    await expect(invitations.preview(invitation.value)).rejects.toMatchObject({
      status: 410,
    });
  });

  it("rotates links and verification sessions on resend, cancels revoked work and rejects duplicate invitations", async () => {
    const invitation = await invite("viewer@example.test", "viewer");
    const proof = await verified(invitation.id, invitation.value);

    await expect(invite("VIEWER@example.test", "viewer")).rejects.toMatchObject(
      { status: 409 },
    );
    const staleJob = await claimMail(mail);

    await invitations.change(ownerHeaders, invitation.id, "resend");
    const replacement = await mailToken(invitation.id);

    expect(replacement === invitation.value).toBe(false);
    await expect(invitations.registrationDetails(proof)).rejects.toMatchObject({
      status: 410,
    });
    await expect(invitations.preview(invitation.value)).rejects.toMatchObject({
      status: 410,
    });
    const send = vi.fn(async () => {});

    await deliverMail(
      mail,
      staleJob!,
      service.config.MAIL_ENCRYPTION_KEY,
      send,
    );
    await retryMail(mail, staleJob!);
    expect(send).not.toHaveBeenCalled();
    expect(
      (await web.mailOutbox.findUniqueOrThrow({ where: { id: staleJob!.id } }))
        .status,
    ).toBe("pending");
    await invitations.change(ownerHeaders, invitation.id, "revoke");
    await expect(invitations.preview(replacement)).rejects.toMatchObject({
      status: 410,
    });
    expect(await claimMail(mail)).toBeNull();
    expect(
      await web.mailOutbox.count({ where: { payload: { not: null } } }),
    ).toBe(0);
  });

  it("accepts only a matching verified account and preserves an existing membership", async () => {
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
    // An existing membership created after the invitation must never be overwritten by acceptance.
    const next = await invite("other@example.test", "viewer");
    const proof = await verified(next.id, next.value);

    await web.invitation.update({
      where: { id: next.id },
      data: { email: "existing@example.test" },
    });
    await expect(
      invitations.accept(invited.headers, proof, true),
    ).rejects.toMatchObject({ status: 409, reason: "member_exists" });
    expect(
      (await web.member.findUniqueOrThrow({ where: { id: current.member.id } }))
        .role,
    ).toBe("developer");
  });

  it("rejects expired invitations, proof replay and registration after revocation", async () => {
    const invitation = await invite("expired@example.test");

    await invitations.requestVerification(invitation.value, "request");
    const proofToken = await mailToken(invitation.id, "verification");
    const registration = await invitations.verifyEmail(proofToken, "verify");

    await expect(
      invitations.verifyEmail(proofToken, "replay"),
    ).rejects.toMatchObject({ status: 410 });
    await invitations.change(ownerHeaders, invitation.id, "revoke");
    await expect(
      invitations.register(registration, { name: "Late", password }, "late"),
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

    await expect(
      invitations.change(ownerHeaders, expired.id, "resend"),
    ).rejects.toMatchObject({ status: 409 });
    await expect(invitations.preview(newest.value)).resolves.toBeDefined();
  });
});

describe("server-side roles and teams", () => {
  it("scopes Developer/Viewer reads to teams and restricts mutations and administration", async () => {
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

    expect(
      await web.project.count({
        where: projectScope((await service.authorize(ownerHeaders)).member),
      }),
    ).toBe(2);
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
      saveMember(service, developer.headers, viewer.member.id, {
        role: "owner",
        active: true,
        teamIds,
      }),
    ).rejects.toMatchObject({ status: 403 });
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
    await expect(
      invitations.create(ownerHeaders, {
        email: "owner2@example.test",
        role: "owner",
        teamIds,
      }),
    ).rejects.toThrow();
    await expect(
      invitations.create(ownerHeaders, {
        email: "bad@example.test",
        role: "viewer",
        teamIds: [randomUUID()],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("revokes live sessions on access changes, allows reactivation and protects the last project-team link", async () => {
    const developer = await participant("developer@example.test");

    await saveMember(service, ownerHeaders, developer.member.id, {
      role: "viewer",
      active: true,
      teamIds: [teamIds[0]],
    });
    await expect(service.authorize(developer.headers)).rejects.toMatchObject({
      status: 401,
    });
    const refreshed = await login("developer@example.test");

    expect((await service.authorize(refreshed)).member.role).toBe("viewer");
    await saveMember(service, ownerHeaders, developer.member.id, {
      role: "viewer",
      active: false,
      teamIds: [],
    });
    await expect(service.authorize(refreshed)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      service.authorize(await login("developer@example.test")),
    ).rejects.toMatchObject({ status: 403 });
    await saveMember(service, ownerHeaders, developer.member.id, {
      role: "developer",
      active: true,
      teamIds,
    });
    const restored = await login("developer@example.test");
    const project = await web.project.create({
      data: {
        organizationId,
        name: "Linked",
        slug: "linked",
        teams: { create: { teamId: teamIds[0]! } },
      },
    });

    await expect(
      saveTeam(service, ownerHeaders, teamIds[0], {
        name: "Frontend",
        memberIds: [],
        projectIds: [],
      }),
    ).rejects.toMatchObject({ status: 409, reason: "project_team" });
    await saveTeam(service, ownerHeaders, teamIds[1], {
      name: "Backend",
      memberIds: [],
      projectIds: [project.id],
    });
    await saveTeam(service, ownerHeaders, teamIds[0], {
      name: "Frontend",
      memberIds: [],
      projectIds: [],
    });
    await expect(service.authorize(restored)).rejects.toMatchObject({
      status: 401,
    });
    const current = await service.authorize(
      await login("developer@example.test"),
    );

    expect(
      await web.project.count({ where: projectScope(current.member) }),
    ).toBe(0);
  });

  it("requires recent TOTP for Owner actions and never disables or demotes the last active Owner", async () => {
    await expect(
      saveMember(service, ownerHeaders, ownerId, {
        role: "viewer",
        active: true,
        teamIds,
      }),
    ).rejects.toMatchObject({ reason: "last_owner" });
    await expect(
      saveMember(service, ownerHeaders, ownerId, {
        role: "owner",
        active: false,
        teamIds,
      }),
    ).rejects.toMatchObject({ reason: "last_owner" });
    const { session } = await service.authorize(ownerHeaders);

    await web.session.update({
      where: { id: session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) },
    });
    await expect(invite("stale@example.test")).rejects.toMatchObject({
      status: 428,
    });
  });

  it("enrolls optional MFA, requires it for promotion and serializes concurrent last-owner changes", async () => {
    const developer = await participant("developer@example.test");

    await expect(
      saveMember(service, ownerHeaders, developer.member.id, {
        role: "owner",
        active: true,
        teamIds,
      }),
    ).rejects.toMatchObject({ reason: "owner_mfa" });
    const mfa = new MfaService(service);

    await expect(
      mfa.prepare(developer.headers, { password: token() }, "bad-password"),
    ).rejects.toThrow();
    const pending = await mfa.prepare(
      developer.headers,
      { password },
      "enroll",
    );
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    let codes: string[];

    try {
      codes = (
        await mfa.finish(
          developer.headers,
          { code: totp(pending.secret, period() - 1n) },
          "finish",
        )
      ).recoveryCodes;
    } finally {
      clock.mockRestore();
    }

    expect(codes!).toHaveLength(10);
    await expect(service.authorize(developer.headers)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      service.login(
        { email: "developer@example.test", password, trustDevice: false },
        "missing-mfa",
      ),
    ).rejects.toThrow();
    const beforePromotion = await login("developer@example.test", {
      recoveryCode: codes![0],
    });

    await saveMember(service, ownerHeaders, developer.member.id, {
      role: "owner",
      active: true,
      teamIds,
    });
    await expect(service.authorize(beforePromotion)).rejects.toMatchObject({
      status: 401,
    });
    const promoted = await login("developer@example.test", {
      code: totp(pending.secret, period()),
    });

    await expect(
      mfa.disable(
        promoted,
        { password, recoveryCode: codes![1] },
        "disable-owner",
      ),
    ).rejects.toMatchObject({ status: 403 });
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

  it("disables optional MFA only with password and a factor and invalidates its recovery codes", async () => {
    const viewer = await participant("viewer@example.test", "viewer");
    const mfa = new MfaService(service);
    const pending = await mfa.prepare(viewer.headers, { password }, "prepare");
    const { recoveryCodes } = await mfa.finish(
      viewer.headers,
      { code: totp(pending.secret, period()) },
      "finish",
    );
    const headers = await login("viewer@example.test", {
      recoveryCode: recoveryCodes[0],
    });

    await mfa.disable(
      headers,
      { password, recoveryCode: recoveryCodes[1] },
      "disable",
    );
    await expect(service.authorize(headers)).rejects.toMatchObject({
      status: 401,
    });
    expect(
      await web.mfaCredential.count({ where: { userId: viewer.user.id } }),
    ).toBe(0);
    expect(
      await web.recoveryCode.count({ where: { userId: viewer.user.id } }),
    ).toBe(0);
    await expect(
      service.authorize(await login("viewer@example.test")),
    ).resolves.toBeDefined();
  });
});

describe("isolated mail outbox", () => {
  it("denies the mail role access to accounts, memberships, invitation tokens and event data", async () => {
    await expect(mail.user.count()).rejects.toThrow();
    await expect(mail.account.count()).rejects.toThrow();
    await expect(mail.member.count()).rejects.toThrow();
    await expect(mail.invitation.count()).rejects.toThrow();
    await expect(mail.errorEvent.count()).rejects.toThrow();
    await expect(mail.mailOutbox.deleteMany()).rejects.toThrow();
    expect(await mail.mailOutbox.count()).toBe(0);
  });

  it("sends once per lease, clears payload on success and bounds retries without retaining errors", async () => {
    const delivered = await invite("mail@example.test");
    const jobs = await Promise.all([claimMail(mail), claimMail(mail)]);

    expect(jobs.filter(Boolean)).toHaveLength(1);
    const job = jobs.find(Boolean)!;
    const send = vi.fn(async () => {});

    await deliverMail(mail, job, service.config.MAIL_ENCRYPTION_KEY, send);
    await deliverMail(mail, job, service.config.MAIL_ENCRYPTION_KEY, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (await web.mailOutbox.findUniqueOrThrow({ where: { id: job.id } }))
        .payload,
    ).toBeNull();
    await invitations.change(ownerHeaders, delivered.id, "revoke");
    expect(
      (await web.mailOutbox.findUniqueOrThrow({ where: { id: job.id } }))
        .status,
    ).toBe("sent");
    const failed = await invite("retry@example.test");
    const fail = vi.fn(async () => {
      throw new Error("SMTP test error containing sensitive content");
    });

    for (let attempt = 0; attempt < 5; attempt++) {
      await web.mailOutbox.updateMany({
        where: { invitationId: failed.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await runMail(mail, service.config.MAIL_ENCRYPTION_KEY, fail);
    }

    expect(fail).toHaveBeenCalledTimes(5);
    expect(
      await web.mailOutbox.findUniqueOrThrow({
        where: {
          invitationId_kind: { invitationId: failed.id, kind: "invitation" },
        },
      }),
    ).toMatchObject({
      payload: null,
      status: "dead",
      attempts: 5,
      lastError: "attempts_exhausted",
    });
    expect(await claimMail(mail)).toBeNull();
  });
});
