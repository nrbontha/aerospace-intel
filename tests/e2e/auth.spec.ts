import { expect, test, type Page } from "@playwright/test";

const email = process.env.ASI_E2E_EMAIL ?? "admin@local.test";
const password =
  process.env.ASI_E2E_PASSWORD ??
  "local-development-admin-password-change-me";

async function signIn(page: Page): Promise<void> {
  // Sign in through the audited API so session cookies land directly in the
  // browser context — immune to client-hydration races on /login.
  const response = await page.request.post("/api/v1/auth/login", {
    data: { username: email, password },
  });
  if (!response.ok()) {
    throw new Error(`Sign-in failed (${response.status()})`);
  }
}

test.describe("unauthenticated health", () => {
  test("health and readiness do not require a session", async ({ request }) => {
    const health = await request.get("/api/v1/health");
    expect(health.status()).toBe(200);
    expect(await health.json()).toMatchObject({
      data: { status: "ok" },
    });

    const ready = await request.get("/api/v1/health/ready");
    expect(ready.status()).toBe(200);
    expect(await ready.json()).toMatchObject({
      data: { status: "ok" },
    });
  });

  test("catalog APIs fail closed without a session", async ({ request }) => {
    const companies = await request.get("/api/v1/companies");
    expect(companies.status()).toBe(401);
  });
});

test.describe("authentication", () => {
  test("rejects an unknown password without revealing account state", async ({
    page,
  }) => {
    // The error path is client-rendered; hydration may lose the race to a
    // native GET submit, so retry until the fetch handler wins.
    let rejected = false;
    for (let attempt = 0; attempt < 5 && !rejected; attempt += 1) {
      await page.goto("/login");
      await page.getByLabel("Username").fill(email);
      await page.getByLabel("Password").fill("definitely-not-the-password");
      await page.getByRole("button", { name: "Sign in" }).click();
      rejected = await page
        .locator("p.login-error")
        .waitFor({ state: "visible", timeout: 3000 })
        .then(() => true)
        .catch(() => false);
    }
    expect(rejected).toBe(true);
    await expect(page.locator("p.login-error")).toHaveText(
      "Unable to sign in with those credentials.",
    );
    await expect(page).toHaveURL(/\/login/);
  });

  test("signs in and reaches the analyst surfaces", async ({ page }) => {
    await signIn(page);
    await page.goto("/feed");
    await expect(
      page.getByRole("heading", { name: "Targets", exact: true }),
    ).toBeVisible();

    // /dashboard is retired and lands on the Targets table.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/feed$/);

    // The company catalog lives under the Universe tab.
    await page.goto("/universe?tab=companies");
    await expect(
      page.getByRole("heading", { name: "Companies", exact: true }),
    ).toBeVisible();

    // Research Queue dissolved into the Needs-research feed view.
    await page.goto("/research-queue");
    await expect(page).toHaveURL(/\/feed\?tier=needs_research$/);
  });

  test("signs out from the account chip and requires login again", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/feed");

    const signOut = page
      .locator("header")
      .getByRole("button", { name: "Sign out" });
    for (
      let attempt = 0;
      attempt < 10 && !page.url().includes("/login");
      attempt += 1
    ) {
      // The button is inert until the app shell hydrates; retry until the
      // handler wins.
      await signOut.click();
      await page.waitForURL(/\/login/, { timeout: 2000 }).catch(() => undefined);
    }
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await page.goto("/dashboard");
    await page.waitForURL(/\/login/);
  });

  test("mutations without a CSRF header are rejected", async ({ page }) => {
    await signIn(page);
    const response = await page.request.post("/api/v1/research-runs", {
      headers: { "content-type": "application/json" },
      data: {
        kind: "company",
        targets: [
          { type: "company", id: "00000000-0000-4000-8000-000000000000" },
        ],
      },
    });
    expect(response.status()).toBe(403);
  });
});
