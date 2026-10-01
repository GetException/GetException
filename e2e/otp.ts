import type { Page } from "@playwright/test";

export async function fillOtp(page: Page, code: string) {
  const cells = page
    .getByRole("group", { name: "Authenticator code" })
    .locator("input.otp-cell");

  for (let index = 0; index < code.length; index += 1) {
    await cells.nth(index).fill(code[index]!);
  }
}
