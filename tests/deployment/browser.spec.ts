import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { totp } from "../../apps/web/src/server/crypto";

async function fillOtp(page: Page, code: string) {
  const cells = page
    .getByRole("group", { name: "Authenticator code" })
    .locator("input.otp-cell");

  for (let index = 0; index < code.length; index += 1) {
    await cells.nth(index).fill(code[index]!);
  }
}

test("installed release: setup, real SDK events and preserved login", async ({
  browser,
}) => {
  const directory = process.env.DEPLOYMENT_TEST_DIR;

  if (!directory) {
    throw new Error(
      "Run yarn test:compose in an isolated Linux Docker environment",
    );
  }

  const sessionFile = join(directory, "runtime/browser-session.json");
  const credentialsFile = join(directory, "runtime/browser-credentials.json");
  const restored = process.env.DEPLOYMENT_VERIFY_RESTART === "1";
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...(restored ? { storageState: sessionFile } : {}),
  });
  const page = await context.newPage();
  const origin = "https://monitor.localhost";
  let phase = "setup";

  try {
    if (restored) {
      await page.goto(origin + "/setup");
      await expect(page).toHaveURL(origin + "/login");
      await page.goto(origin + "/issues");
      await expect(
        page.getByText("Browser fixture error", { exact: false }).first(),
      ).toBeVisible();

      const credentials = JSON.parse(readFileSync(credentialsFile, "utf8")) as {
        email: string;
        password: string;
        secret: string;
        counter: number;
      };

      await context.clearCookies();
      await page.goto(origin + "/login");
      await page.getByLabel("Email", { exact: true }).fill(credentials.email);
      await page
        .getByLabel("Password", { exact: true })
        .fill(credentials.password);
      await expect
        .poll(() => Math.floor(Date.now() / 30_000), { timeout: 65_000 })
        .toBeGreaterThan(credentials.counter);

      const counter = Math.floor(Date.now() / 30_000);

      await fillOtp(page, totp(credentials.secret, BigInt(counter)));
      await expect(
        page.getByRole("heading", { name: "Overview." }),
      ).toBeVisible();
      writeFileSync(
        credentialsFile,
        JSON.stringify({ ...credentials, counter }),
        { mode: 0o600 },
      );
      writeFileSync(sessionFile, JSON.stringify(await context.storageState()), {
        mode: 0o600,
      });

      return;
    }

    await page.goto(origin + "/setup");
    await page
      .getByLabel("Setup token")
      .fill(
        readFileSync(join(directory, "runtime/setup-token"), "utf8").trim(),
      );
    await page.getByRole("button", { name: "Unlock setup" }).click();
    const email = "owner@example.test";
    const password = randomBytes(24).toString("base64url");

    await page.getByLabel("Owner email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    const prepared = page.waitForResponse((response) =>
      response.url().endsWith("/api/setup/prepare"),
    );

    await page.getByRole("button", { name: "Set up authenticator" }).click();
    const secret = (await (await prepared).json()).secret as string;

    await fillOtp(
      page,
      totp(secret, BigInt(Math.floor(Date.now() / 30_000)) - 1n),
    );
    await page.getByRole("link", { name: /I saved my codes/ }).click();
    phase = "login";
    await expect(page.locator(".auth-intro")).toBeVisible();
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    const login = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/login"),
    );

    await fillOtp(page, totp(secret, BigInt(Math.floor(Date.now() / 30_000))));
    expect((await login).status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Overview." }),
    ).toBeVisible();
    const counter = Math.floor(Date.now() / 30_000) + 1;
    const code = totp(secret, BigInt(counter));

    // Random credentials for this disposable database only; never uploaded as artifacts.
    writeFileSync(
      credentialsFile,
      JSON.stringify({ email, password, secret, counter }),
      { mode: 0o600 },
    );
    const stepUp = await page.evaluate(
      async (data) => {
        const response = await fetch("/api/dashboard/step-up", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });

        return response.status;
      },
      { password, code, trustDevice: false },
    );

    expect(stepUp).toBe(200);
    phase = "manual invitation";
    await page.goto(origin + "/members");
    await page.getByLabel("Email", { exact: true }).fill("viewer@example.test");
    await page.getByRole("checkbox").first().check();
    await page
      .getByRole("button", { name: "Create invitation link", exact: true })
      .click();
    await expect(page.getByTestId("invitation-link")).toContainText("/invite#");

    phase = "delete member";
    const invitationLink = await page
      .getByTestId("invitation-link")
      .innerText();
    const memberContext = await browser.newContext({ ignoreHTTPSErrors: true });

    try {
      const memberPage = await memberContext.newPage();

      await memberPage.goto(invitationLink);
      await memberPage.getByLabel("Your name").fill("Temporary member");
      await memberPage
        .locator("form")
        .filter({
          has: memberPage.getByRole("button", {
            name: "Continue to authenticator",
          }),
        })
        .getByLabel("Password", { exact: true })
        .fill(randomBytes(24).toString("hex"));
      const enrollment = memberPage.waitForResponse((response) =>
        response.url().endsWith("/api/invitations/begin-registration"),
      );

      await memberPage
        .getByRole("button", { name: "Continue to authenticator" })
        .click();
      const memberSecret = (await (await enrollment).json()).secret as string;

      await fillOtp(
        memberPage,
        totp(memberSecret, BigInt(Math.floor(Date.now() / 30_000))),
      );
      await memberPage.getByRole("link", { name: /I saved my codes/ }).click();
      await expect(
        memberPage.getByRole("heading", { name: "Overview." }),
      ).toBeVisible();
      await page.goto(origin + "/members");
      await page
        .getByRole("link", { name: "Temporary member", exact: true })
        .click();
      await page.getByLabel("Confirm member email").fill("wrong@example.test");
      await page
        .getByRole("button", { name: "Delete member", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText(
        "Enter this member's email",
      );
      await page.getByLabel("Confirm member email").fill("viewer@example.test");
      await page
        .getByRole("button", { name: "Delete member", exact: true })
        .click();
      await expect(page).toHaveURL(origin + "/members");
      await expect(
        page.getByRole("link", { name: "Temporary member", exact: true }),
      ).toHaveCount(0);
      await memberPage.reload();
      await expect(memberPage).toHaveURL(origin + "/login");
    } finally {
      await memberContext.close();
    }

    phase = "project";
    await page.goto(origin + "/projects/new");
    await page.getByLabel("Project name").fill("Release validation");
    await page.getByLabel("Project slug").fill("release-validation");
    await page.getByLabel(/Allowed origins/).fill("http://app.example.com");
    const invalidOrigin = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/dashboard/projects") &&
        response.request().method() === "POST",
    );

    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    expect((await invalidOrigin).status()).toBe(400);
    await expect(page.getByText(/Enter an exact HTTPS origin/)).toBeVisible();
    await page
      .getByLabel(/Allowed origins/)
      .fill(
        "https://browser.monitor.localhost\nhttps://react.monitor.localhost\nhttp://localhost:8080",
      );
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    const dsn = await page.getByTestId("project-dsn").textContent();

    if (!dsn) {
      throw new Error("Missing DSN");
    }

    phase = "SDK capture";
    const fixture = await context.newPage();

    await fixture.goto("https://browser.monitor.localhost");
    await fixture.getByLabel("DSN", { exact: true }).fill(dsn);
    await fixture.getByRole("button", { name: "Connect", exact: true }).click();
    const canary = randomBytes(24).toString("hex");

    await fixture.evaluate((value) => {
      localStorage.setItem("test-secret", value);
      document.cookie = `test_secret=${value}`;
      history.replaceState({}, "", `/?token=${value}#${value}`);
    }, canary);
    const event = fixture.waitForRequest(
      (request) =>
        request.url().includes("/envelope/") && request.method() === "POST",
    );
    const accepted = fixture.waitForResponse(
      (response) =>
        response.url().includes("/envelope/") &&
        response.request().method() === "POST",
    );

    await fixture
      .getByRole("button", { name: "Handled error", exact: true })
      .click();
    const sent = await event;

    expect((await accepted).status()).toBe(200);
    const headers = await sent.allHeaders();

    expect(
      Boolean(headers.cookie || headers.authorization || headers.referer),
    ).toBe(false);
    expect((sent.postData() ?? "").includes(canary)).toBe(false);

    for (const name of [
      "Handled error",
      "Unhandled error",
      "Unhandled rejection",
    ]) {
      const response = fixture.waitForResponse(
        (response) =>
          response.url().includes("/envelope/") &&
          response.request().method() === "POST",
      );

      await fixture.getByRole("button", { name, exact: true }).click();
      expect((await response).status()).toBe(200);
    }

    await fixture.goto("https://react.monitor.localhost");
    await fixture.getByLabel("DSN", { exact: true }).fill(dsn);
    await fixture.getByRole("button", { name: "Connect", exact: true }).click();
    await fixture.getByRole("button", { name: "Trigger boundary" }).click();
    await expect(fixture.getByRole("status")).toHaveText(
      "The application is still available.",
    );
    phase = "worker results";
    await expect
      .poll(
        async () => {
          await page.goto(origin + "/issues");

          return page
            .getByText("React fixture boundary error", { exact: false })
            .count();
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    await expect(
      page.getByText("Browser fixture error", { exact: false }).first(),
    ).toBeVisible();
    await page
      .getByText("Browser fixture error", { exact: false })
      .first()
      .click();
    await expect(
      page.getByRole("link", { name: /01234567/ }).first(),
    ).toBeVisible();
    phase = "project settings and recovery";
    const projectId = new URL(dsn).pathname.slice(1);

    await page.goto(`${origin}/projects/${projectId}`);
    await page
      .getByRole("link", { name: "Project settings", exact: true })
      .click();
    await page.getByLabel("Project name").fill("Updated validation project");
    await page
      .getByLabel(/Allowed origins/)
      .fill(
        "https://browser.monitor.localhost\nhttps://react.monitor.localhost\nhttp://localhost:8080\nhttp://localhost:3000",
      );
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Project saved");
    await page.reload();
    await expect(page.getByLabel("Project name")).toHaveValue(
      "Updated validation project",
    );
    await expect(page.getByLabel(/Allowed origins/)).toHaveValue(
      /http:\/\/localhost:3000/,
    );
    await page.getByLabel("Confirm project slug").fill("wrong-slug");
    await page
      .getByRole("button", { name: "Delete project", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "current project slug" }),
    ).toBeVisible();
    await page.getByLabel("Confirm project slug").fill("release-validation");
    await page
      .getByRole("button", { name: "Delete project", exact: true })
      .click();
    await expect(page).toHaveURL(origin + "/projects/deleted");
    await expect(
      page.getByRole("heading", {
        name: "Updated validation project",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Restore project", exact: true })
      .click();
    await expect(page).toHaveURL(`${origin}/projects/${projectId}`);
    await page.getByRole("link", { name: "View issues", exact: false }).click();
    await expect(
      page.getByText("Browser fixture error", { exact: false }).first(),
    ).toBeVisible();
    phase = "origin isolation";
    const isolated = await context.newPage();
    const outgoing = isolated.waitForRequest(
      "https://ingest.monitor.localhost/api/dashboard/status",
    );

    await isolated
      .goto("https://ingest.monitor.localhost/api/dashboard/status")
      .catch((error: Error) => {
        if (!error.message.includes("net::ERR_HTTP_RESPONSE_CODE_FAILURE")) {
          throw error;
        }
      });

    expect(Boolean((await (await outgoing).allHeaders()).cookie)).toBe(false);
    writeFileSync(sessionFile, JSON.stringify(await context.storageState()), {
      mode: 0o600,
    });
  } catch {
    // Never let Playwright error output serialize a setup secret, DSN, cookie or password.
    throw new Error("Deployment browser check failed during: " + phase);
  } finally {
    await context.close();
  }
});
