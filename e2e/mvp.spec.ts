import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { totp } from "../apps/web/src/server/crypto";
import { startStack } from "./stack";

let stack: Awaited<ReturnType<typeof startStack>>;

test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.cleanup();
});
test("protected setup → SDK capture → workspace navigation → investigation and regression", async ({
  browser,
}, info) => {
  const privateContext = await browser.newContext({ ignoreHTTPSErrors: true });

  privateContext.setDefaultTimeout(10_000);
  const page = await privateContext.newPage();
  const email = "owner@example.test";
  const password = randomBytes(24).toString("base64url");
  let phase = "setup";

  try {
    await page.goto(stack.origin + "/setup");
    await expect(page.getByLabel("Setup token")).toBeVisible();
    await page.getByLabel("Setup token").fill(stack.setupToken);
    await page.getByRole("button", { name: "Unlock setup" }).click();
    await page.getByLabel("Owner email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    const prepareResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/setup/prepare"),
    );

    await page.getByRole("button", { name: "Set up authenticator" }).click();
    const prepared = await prepareResponse;

    expect(prepared.headers()["cache-control"]).toBe("no-store");
    const secret = (await prepared.json()).secret as string;

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
    const loginResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/owner/login"),
    );

    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    expect((await loginResponse).headers()["cache-control"]).toBe("no-store");
    phase = "login redirect";
    await expect(
      page.getByRole("heading", { name: "Overview." }),
    ).toBeVisible();
    phase = "cookie attributes";
    const sessionCookies = await privateContext.cookies(stack.origin);

    expect(
      sessionCookies.some(
        (cookie) =>
          cookie.name.startsWith("__Host-") &&
          cookie.secure &&
          cookie.httpOnly &&
          cookie.domain === "monitor.localhost",
      ),
    ).toBe(true);
    phase = "cookie isolation";
    // Playwright filters cookies by domain suffix even for host-only cookies;
    // inspect an actual Chromium navigation to the ingest host instead.
    const isolated = await privateContext.newPage();
    const isolatedRequest = isolated.waitForRequest(stack.ingestOrigin + "/");

    phase = "ingest navigation";
    await isolated.goto(stack.ingestOrigin + "/").catch((error: Error) => {
      if (!error.message.includes("net::ERR_HTTP_RESPONSE_CODE_FAILURE")) {
        throw error;
      }
    });
    phase = "outbound cookie header";
    expect(Boolean((await (await isolatedRequest).allHeaders()).cookie)).toBe(
      false,
    );
    await isolated.close();
    phase = "closed setup";
    await page.goto(stack.origin + "/setup");
    await expect(page).toHaveURL(stack.origin + "/login");
    // Direct built-in routes cannot bypass the closed auth surface.
    // APIRequestContext uses the OS DNS resolver, unlike Chromium's localhost mapping.
    // Connect to loopback with the actual TLS SNI and Host to exercise the same Caddy routes.
    const send = (
      target: string,
      method: string,
      options: { headers?: Record<string, string>; data?: unknown } = {},
    ) =>
      new Promise<{
        status: () => number;
        headers: () => Record<string, string>;
      }>((resolve, reject) => {
        const url = new URL(target);
        const body =
          options.data === undefined ? undefined : JSON.stringify(options.data);
        const cookie = sessionCookies
          .filter((value) => value.domain === url.hostname)
          .map((value) => `${value.name}=${value.value}`)
          .join("; ");
        const req = httpsRequest(
          {
            hostname: "127.0.0.1",
            servername: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            rejectUnauthorized: false,
            headers: {
              Host: url.host,
              ...(cookie ? { Cookie: cookie } : {}),
              ...(body
                ? {
                    "Content-Type": "application/json",
                    "Content-Length": String(Buffer.byteLength(body)),
                  }
                : {}),
              ...options.headers,
            },
          },
          (response) => {
            response.resume();
            response.once("end", () =>
              resolve({
                status: () => response.statusCode ?? 0,
                headers: () => response.headers as Record<string, string>,
              }),
            );
          },
        );

        req.setTimeout(5000, () =>
          req.destroy(new Error("Local HTTPS request timed out")),
        );
        req.once("error", () =>
          reject(new Error("Local HTTPS request failed")),
        );
        req.end(body);
      });
    const requests = {
      get: (url: string) => send(url, "GET"),
      post: (
        url: string,
        options?: { headers?: Record<string, string>; data?: unknown },
      ) => send(url, "POST", options),
    };

    phase = "closed auth routes";

    for (const path of [
      "sign-up/email",
      "two-factor/verify-otp",
      "two-factor/verify-totp",
      "organization/create-invitation",
    ]) {
      const response = await requests.post(stack.origin + "/api/auth/" + path, {
        headers: { Origin: stack.origin },
        data: {},
      });

      expect(response.status()).toBe(404);
    }

    phase = "project";
    const status = await requests.get(stack.origin + "/api/dashboard/status");

    expect(status.status()).toBe(200);
    expect(status.headers()["cache-control"]).toBe("no-store");
    const stepUp = await requests.post(
      stack.origin + "/api/dashboard/step-up",
      {
        headers: { Origin: stack.origin },
        data: {
          password,
          code: totp(secret, BigInt(Math.floor(Date.now() / 30_000)) + 1n),
          trustDevice: false,
        },
      },
    );

    expect(stepUp.status()).toBe(200);
    expect(stepUp.headers()["cache-control"]).toBe("no-store");
    await page.goto(stack.origin + "/projects/new");
    await page.getByLabel("Project name").fill("Browser checkout");
    await page.getByLabel("Project slug").fill("checkout");
    await page
      .getByLabel(/Allowed origins/)
      .fill(stack.browserOrigin + "\n" + stack.reactOrigin);
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    const dsn = await page.getByTestId("project-dsn").textContent();

    if (!dsn) {
      throw new Error("Project DSN was not issued");
    }

    phase = "SDK capture";
    const fixture = await privateContext.newPage();

    await fixture.goto(stack.browserOrigin);
    await fixture.getByLabel("DSN", { exact: true }).fill(dsn);
    await fixture.getByRole("button", { name: "Connect", exact: true }).click();
    const canary = randomBytes(24).toString("hex");

    await fixture.evaluate((value) => {
      localStorage.setItem("test-secret", value);
      sessionStorage.setItem("test-secret", value);
      document.cookie = `fixture_secret=${value}`;
      history.replaceState({}, "", `/?token=${value}#${value}`);
    }, canary);
    const ingestion = fixture.waitForRequest((request) =>
      request.url().includes("/envelope/"),
    );

    await fixture
      .getByRole("button", { name: "Handled error", exact: true })
      .click();
    const sent = await ingestion;
    const headers = await sent.allHeaders();

    expect(
      Boolean(headers.cookie || headers.referer || headers.authorization),
    ).toBe(false);
    expect((sent.postData() ?? "").includes(canary)).toBe(false);
    await fixture
      .getByRole("button", { name: "Unhandled error", exact: true })
      .click();
    await fixture
      .getByRole("button", { name: "Unhandled rejection", exact: true })
      .click();
    const react = await privateContext.newPage();

    await react.goto(stack.reactOrigin);
    await react.getByLabel("DSN", { exact: true }).fill(dsn);
    await react.getByRole("button", { name: "Connect", exact: true }).click();
    await react.getByRole("button", { name: "Trigger boundary" }).click();
    await expect(react.getByRole("status")).toHaveText(
      "The application is still available.",
    );
    await expect
      .poll(async () => stack.database.admin.errorEvent.count(), {
        timeout: 15_000,
      })
      .toBe(4);
    expect(
      JSON.stringify(await stack.database.admin.errorEvent.findMany()).includes(
        canary,
      ),
    ).toBe(false);
    expect(
      (
        await requests.post(
          stack.origin + `/api/${new URL(dsn).pathname.slice(1)}/envelope/`,
        )
      ).status(),
    ).toBe(404);
    expect(
      (
        await requests.get(stack.ingestOrigin + "/api/dashboard/status")
      ).status(),
    ).toBe(404);
    expect((await requests.get(stack.origin + "/metrics")).status()).toBe(404);
    await fixture
      .getByRole("button", { name: "Handled error", exact: true })
      .click();
    await expect
      .poll(async () => stack.database.admin.errorEvent.count(), {
        timeout: 15_000,
      })
      .toBe(5);
    // Only this non-sensitive dashboard context can produce failure artifacts.
    phase = "dashboard verification";
    const proof = await browser.newContext({
      ignoreHTTPSErrors: true,
      recordVideo: { dir: info.outputPath("video") },
      viewport: { width: 1500, height: 1050 },
    });

    proof.setDefaultTimeout(10_000);
    proof.setDefaultNavigationTimeout(15_000);
    await proof.addCookies(sessionCookies);
    const dashboard = await proof.newPage();

    await proof.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: false,
    });
    phase = "workspace assertions";
    let failed = false;
    let proofError: unknown;

    try {
      await dashboard.goto(stack.origin);
      const navigation = dashboard.getByRole("navigation", {
        name: "Main navigation",
      });

      await expect(navigation.getByRole("link")).toHaveCount(8);
      await expect(
        navigation.getByRole("link", { name: "Overview", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        dashboard.getByRole("heading", { name: "Error activity" }),
      ).toBeVisible();
      await expect(
        dashboard.getByText("Browser fixture error", { exact: true }),
      ).toHaveCount(0);
      await dashboard.screenshot({
        path: info.outputPath("overview-desktop.png"),
        fullPage: true,
      });
      await navigation
        .getByRole("link", { name: "Issues", exact: true })
        .click();
      await expect(
        navigation.getByRole("link", { name: "Issues", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        navigation.getByRole("link", { name: "Overview", exact: true }),
      ).not.toHaveAttribute("aria-current", "page");
      await expect(
        dashboard.getByText("Browser fixture error", { exact: true }),
      ).toBeVisible();
      await expect(
        dashboard.getByText("React fixture boundary error", { exact: true }),
      ).toBeVisible();
      await dashboard
        .getByRole("textbox", { name: "Search", exact: true })
        .fill("React fixture");
      await dashboard.getByRole("button", { name: "Apply filters" }).click();
      await expect(
        dashboard.getByText("React fixture boundary error", { exact: true }),
      ).toBeVisible();
      await expect(
        dashboard.getByText("Browser fixture error", { exact: true }),
      ).toHaveCount(0);
      await dashboard
        .getByRole("textbox", { name: "Search", exact: true })
        .fill("");
      await dashboard
        .getByLabel("Environment", { exact: true })
        .selectOption("production");
      await dashboard.getByRole("button", { name: "Apply filters" }).click();
      await expect(
        dashboard.getByRole("heading", { name: "No issues match this view" }),
      ).toBeVisible();
      await dashboard.getByRole("link", { name: "Clear all filters" }).click();
      await dashboard.screenshot({
        path: info.outputPath("issues-desktop.png"),
        fullPage: true,
      });
      await dashboard
        .getByText("Browser fixture error", { exact: true })
        .click();
      await expect(
        dashboard.getByRole("heading", { name: "Stack trace" }),
      ).toBeVisible();
      await expect(dashboard.locator(".stack")).toContainText(".js");
      await expect(
        dashboard.getByRole("heading", { name: "Event details" }),
      ).toBeVisible();
      await expect(dashboard.locator(".events-table tbody tr")).toHaveCount(2);
      await dashboard.getByRole("tab", { name: /Breadcrumbs/ }).click();
      await expect(dashboard.getByRole("tabpanel")).toContainText(
        "fixture-test",
      );
      // Base UI tabs support keyboard navigation as well as pointer activation.
      await dashboard
        .getByRole("tab", { name: /Breadcrumbs/ })
        .press("ArrowLeft");
      await expect(
        dashboard.getByRole("tab", { name: "Events", exact: true }),
      ).toBeFocused();
      await dashboard
        .getByRole("tab", { name: "Events", exact: true })
        .press("Enter");
      await expect(
        dashboard.getByRole("tab", { name: "Events", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await dashboard
        .getByRole("link", { name: "← Previous event", exact: true })
        .click();
      await expect(dashboard).toHaveURL(/event=[a-f0-9]{32}/);
      const previousEventUrl = dashboard.url();

      await dashboard
        .getByRole("link", { name: "Next event →", exact: true })
        .click();
      await expect(dashboard).not.toHaveURL(previousEventUrl);
      await dashboard
        .getByRole("button", { name: "Application frames", exact: true })
        .click();
      await expect(
        dashboard.getByRole("button", {
          name: "Application frames",
          exact: true,
        }),
      ).toHaveAttribute("aria-pressed", "true");
      await dashboard.screenshot({
        path: info.outputPath("issue-desktop.png"),
        fullPage: true,
      });
      const issueUrl = dashboard.url();

      await dashboard
        .getByRole("button", { name: "✓ Resolve issue", exact: true })
        .click();
      await expect(
        dashboard.getByRole("button", { name: "Reopen issue", exact: true }),
      ).toBeVisible();
      await navigation
        .getByRole("link", { name: "Issues", exact: true })
        .click();
      await dashboard
        .getByRole("link", { name: "Resolved", exact: true })
        .click();
      await expect(
        dashboard.getByText("Browser fixture error", { exact: true }),
      ).toBeVisible();
      await dashboard.getByRole("link", { name: "Open", exact: true }).click();
      await expect(
        dashboard.getByText("Browser fixture error", { exact: true }),
      ).toHaveCount(0);
      await fixture
        .getByRole("button", { name: "Handled error", exact: true })
        .click();
      await expect
        .poll(async () => stack.database.admin.errorEvent.count(), {
          timeout: 15_000,
        })
        .toBe(6);
      await dashboard
        .getByRole("link", { name: "Regressions", exact: true })
        .click();
      await expect(
        dashboard.getByText("Browser fixture error", { exact: true }),
      ).toBeVisible();
      await dashboard
        .getByText("Browser fixture error", { exact: true })
        .click();
      await expect(dashboard.locator(".issue-heading .status")).toHaveText(
        "Regression",
      );
      await navigation
        .getByRole("link", { name: "Releases", exact: true })
        .click();
      await expect(
        dashboard.getByRole("heading", { name: "Releases." }),
      ).toBeVisible();
      await dashboard.getByRole("link", { name: /browser-fixture@/ }).click();
      await expect(
        dashboard.getByRole("heading", { name: /01234567/ }),
      ).toBeVisible();
      await dashboard
        .getByRole("link", { name: /View release issues/ })
        .click();
      await expect(
        dashboard.getByText("Browser fixture error", { exact: true }),
      ).toBeVisible();
      await expect(
        dashboard.getByText("React fixture boundary error", { exact: true }),
      ).toHaveCount(0);
      await navigation
        .getByRole("link", { name: "Projects", exact: true })
        .click();
      await dashboard.getByRole("link", { name: /Browser checkout/ }).click();
      await expect(
        dashboard.getByRole("heading", { name: "Project details" }),
      ).toBeVisible();
      await expect(
        dashboard.getByRole("heading", { name: "Ingestion keys" }),
      ).toBeVisible();
      await expect(dashboard.locator(".code-block")).toContainText(
        "<YOUR_SAVED_DSN>",
      );
      await navigation
        .getByRole("link", { name: "Teams", exact: true })
        .click();
      await expect(
        dashboard.getByRole("heading", { name: "Default", exact: true }),
      ).toBeVisible();
      await navigation
        .getByRole("link", { name: "Members", exact: true })
        .click();
      await expect(dashboard.getByRole("table")).toContainText(email);
      await navigation
        .getByRole("link", { name: "Audit log", exact: true })
        .click();
      await dashboard
        .getByLabel("Action", { exact: true })
        .selectOption("issue_resolve");
      await dashboard.getByRole("button", { name: "Apply filters" }).click();
      await expect(dashboard.getByRole("table")).toContainText(
        "Issue resolved",
      );
      await navigation
        .getByRole("link", { name: "Settings", exact: true })
        .click();
      await expect(
        dashboard.getByRole("heading", { name: "Your account" }),
      ).toBeVisible();
      await expect(
        dashboard.getByRole("heading", { name: "Confirm your identity" }),
      ).toBeVisible();
      await dashboard.goto(issueUrl);
      await dashboard.setViewportSize({ width: 390, height: 844 });
      await expect(
        dashboard.getByRole("heading", { name: "Stack trace" }),
      ).toBeVisible();
      expect(
        await dashboard.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await dashboard.screenshot({
        path: info.outputPath("issue-mobile.png"),
        fullPage: true,
      });
    } catch (error) {
      failed = true;
      proofError = error;
      const screenshot = info.outputPath("dashboard.png");

      await dashboard.screenshot({ path: screenshot, fullPage: true });
      await info.attach("dashboard", {
        path: screenshot,
        contentType: "image/png",
      });
    }

    try {
      const trace = info.outputPath("trace.zip");

      await proof.tracing.stop(failed ? { path: trace } : undefined);
      const video = dashboard.video();

      await proof.close();

      if (failed) {
        const sanitize = spawnSync("python3", [
          "scripts/sanitize-trace.py",
          trace,
        ]);

        if (sanitize.status !== 0) {
          await unlink(trace);

          throw new Error("Trace sanitization failed; artifact deleted");
        }

        await info.attach("trace", {
          path: trace,
          contentType: "application/zip",
        });

        if (video) {
          await info.attach("video", {
            path: await video.path(),
            contentType: "video/webm",
          });
        }
      } else if (video) {
        await video.delete();
      }
    } finally {
      await proof.close();
    }

    if (failed) {
      throw proofError;
    }
  } catch (error) {
    if (phase === "workspace assertions") {
      throw error;
    }

    const category =
      error instanceof Error
        ? (error.message.match(/net::ERR_[A-Z_]+/)?.[0] ?? error.name)
        : "unknown";

    throw new Error(
      `MVP E2E failed during ${phase} (${category}). Sensitive diagnostics were suppressed.`,
    );
  } finally {
    await privateContext.close();
  }
});
