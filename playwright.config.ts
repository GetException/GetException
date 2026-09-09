import { defineConfig } from "@playwright/test";

// Disable automatic failure DOM snapshots, which could include the setup seed.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  outputDir: "test-results",
  use: {
    browserName: "chromium",
    ignoreHTTPSErrors: true,
    // Sensitive setup/login/DSN and fixture traffic MUST NOT be recorded.
    // The spec creates a separate context for failure-only sanitized dashboard artifacts.
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    },
  },
});
