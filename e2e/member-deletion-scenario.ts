import { expect, type Browser, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { totp } from "../apps/web/src/server/crypto";
import { fillOtp } from "./otp";

export async function verifyMemberDeletion(
  browser: Browser,
  page: Page,
  origin: string,
  onPhase: (phase: string) => void,
) {
  onPhase("create invitation");
  await page.goto(origin + "/members");
  await page.getByLabel("Email", { exact: true }).fill("viewer@example.test");
  await page.getByRole("checkbox").first().check();
  await page
    .getByRole("button", { name: "Create invitation link", exact: true })
    .click();
  await expect(page.getByTestId("invitation-link")).toContainText("/invite#");

  onPhase("open invitation");
  const invitationLink = await page.getByTestId("invitation-link").innerText();
  const memberContext = await browser.newContext({ ignoreHTTPSErrors: true });

  try {
    const memberPage = await memberContext.newPage();

    await memberPage.goto(invitationLink);
    onPhase("registration name");
    await memberPage.getByLabel("Your name").fill("Temporary member");
    onPhase("registration password");
    await memberPage
      .locator("form")
      .filter({
        has: memberPage.getByRole("button", {
          name: "Continue to authenticator",
        }),
      })
      .getByLabel("Password", { exact: true })
      .fill(randomBytes(24).toString("hex"));
    onPhase("registration submit");
    const enrollment = memberPage.waitForResponse((response) =>
      response.url().endsWith("/api/invitations/begin-registration"),
    );

    await memberPage
      .getByRole("button", { name: "Continue to authenticator" })
      .click();
    const memberSecret = (await (await enrollment).json()).secret as string;

    onPhase("registration TOTP");
    await fillOtp(
      memberPage,
      totp(memberSecret, BigInt(Math.floor(Date.now() / 30_000))),
    );
    onPhase("registration complete");
    await memberPage.getByRole("link", { name: /I saved my codes/ }).click();
    await expect(
      memberPage.getByRole("heading", { name: "Overview." }),
    ).toBeVisible();
    onPhase("member access page");
    await page.goto(origin + "/members");
    await page
      .getByRole("link", { name: "Temporary member", exact: true })
      .click();
    onPhase("wrong deletion confirmation");
    await page.getByLabel("Confirm member email").fill("wrong@example.test");
    const rejected = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes("/api/dashboard/access/members/"),
    );

    await page
      .getByRole("button", { name: "Delete member", exact: true })
      .click();
    const status = (await rejected).status();

    onPhase("wrong deletion response " + status);
    expect(status).toBe(400);
    await expect(
      page.getByText("Enter this member's email to confirm deletion.", {
        exact: true,
      }),
    ).toBeVisible();
    onPhase("confirmed deletion");
    await page.getByLabel("Confirm member email").fill("viewer@example.test");
    await page
      .getByRole("button", { name: "Delete member", exact: true })
      .click();
    await expect(page).toHaveURL(origin + "/members");
    await expect(
      page.getByRole("link", { name: "Temporary member", exact: true }),
    ).toHaveCount(0);
    onPhase("deleted session rejected");
    await memberPage.reload();
    await expect(memberPage).toHaveURL(origin + "/login");
  } finally {
    await memberContext.close();
  }
}
