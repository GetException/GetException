import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { totp } from "../apps/web/src/server/crypto";
import { startStack } from "./stack";
import { fillOtp } from "./otp";

test("login keeps two columns and submits on the sixth authenticator digit", async ({
  browser,
}) => {
  const stack = await startStack();

  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const email = "owner@example.test";
    const password = randomBytes(24).toString("base64url");

    await page.goto(stack.origin + "/setup");
    await page.getByLabel("Setup token").fill(stack.setupToken);
    await page.getByRole("button", { name: "Unlock setup" }).click();
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
    await expect(page.locator(".auth-intro")).toBeVisible();
    const columns = await page
      .locator(".auth-shell-split")
      .evaluate((element) =>
        getComputedStyle(element)
          .gridTemplateColumns.split(" ")
          .map(parseFloat),
      );

    expect(columns).toHaveLength(2);
    expect(columns[0]).toBeGreaterThan(0);
    expect(columns[1]).toBeGreaterThan(0);
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
    await context.close();
  } catch {
    // Playwright errors from setup/login can include credentials entered into the form.
    throw new Error("Login E2E failed; sensitive diagnostics were suppressed.");
  } finally {
    await stack.cleanup();
  }
});
