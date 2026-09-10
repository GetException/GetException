import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { totp } from "../../apps/web/src/server/crypto";

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

    await page
      .getByLabel("Authenticator code")
      .fill(totp(secret, BigInt(Math.floor(Date.now() / 30_000)) - 1n));
    await page.getByRole("button", { name: "Activate installation" }).click();
    await page.getByRole("link", { name: /I saved my codes/ }).click();
    phase = "login";
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page
      .getByLabel("Authenticator code")
      .fill(totp(secret, BigInt(Math.floor(Date.now() / 30_000))));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Overview." }),
    ).toBeVisible();
    const code = totp(secret, BigInt(Math.floor(Date.now() / 30_000)) + 1n);
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
    phase = "email disabled";
    await page.goto(origin + "/members");
    await expect(
      page.getByText(
        /Invitations are unavailable while email delivery is disabled/,
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send invitation", exact: true }),
    ).toHaveCount(0);

    phase = "project";
    await page.goto(origin + "/projects/new");
    await page.getByLabel("Project name").fill("Release validation");
    await page.getByLabel("Project slug").fill("release-validation");
    await page
      .getByLabel(/Allowed origins/)
      .fill(
        "https://browser.monitor.localhost\nhttps://react.monitor.localhost",
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
