import { defineConfig } from "@playwright/test";

process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
  testDir: "./tests/deployment",
  testMatch: "browser.spec.ts",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  use: {
    ignoreHTTPSErrors: true,
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions: {
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    },
  },
});
