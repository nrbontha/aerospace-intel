import { expect, test } from "@playwright/test";

const email = process.env.ASI_E2E_EMAIL ?? "admin@local.test";
const password =
  process.env.ASI_E2E_PASSWORD ??
  "local-development-admin-password-change-me";

test("company search and source catalog are reachable after login", async ({
  page,
}) => {
  // Sign in through the audited API — immune to client-hydration races on
  // the login form.
  const response = await page.request.post("/api/v1/auth/login", {
    data: {
      username: process.env.ASI_E2E_EMAIL ?? "admin@local.test",
      password:
        process.env.ASI_E2E_PASSWORD ??
        "local-development-admin-password-change-me",
    },
  });
  expect(response.ok()).toBe(true);

  await page.goto("/companies");
  await page.getByLabel("Search known companies").fill("Hitchiner");
  await page.locator("#company-query").press("Enter");
  await expect(
    page.getByText(/Hitchiner|No companies match|No companies|No results/i).first(),
  ).toBeVisible();

  await page.goto("/data-sources");
  await expect(page).toHaveURL(/\/universe\?tab=sources$/);
  await expect(
    page.getByRole("heading", { name: "Sources", exact: true }),
  ).toBeVisible();
});
