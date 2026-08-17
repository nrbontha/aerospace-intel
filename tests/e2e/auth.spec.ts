import { expect, test, type Page } from "@playwright/test";

const email = process.env.ASI_E2E_EMAIL ?? "admin@local.test";
const password =
  process.env.ASI_E2E_PASSWORD ??
  "local-development-admin-password-change-me";

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/);
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
    await page.goto("/login");
    await page.getByLabel("Username").fill(email);
    await page.getByLabel("Password").fill("definitely-not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("p.login-error")).toHaveText(
      "Unable to sign in with those credentials.",
    );
    await expect(page).toHaveURL(/\/login/);
  });

  test("signs in and reaches the analyst catalog", async ({ page }) => {
    await signIn(page);
    await expect(
      page.getByRole("heading", { name: "Dashboard", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Companies", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Companies", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Research Queue" }).click();
    await expect(
      page.getByRole("heading", { name: "Proposal review queue" }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Canonical vs proposed" }),
    ).toBeVisible();
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
