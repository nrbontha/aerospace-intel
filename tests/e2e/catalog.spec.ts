import { expect, test } from "@playwright/test";

const email = process.env.ASI_E2E_EMAIL ?? "admin@local.test";
const password =
  process.env.ASI_E2E_PASSWORD ??
  "local-development-admin-password-change-me";

test("company search and source catalog are reachable after login", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/);

  await page.goto("/companies");
  await page.getByLabel("Search known companies").fill("Hitchiner");
  await page.locator("#company-query").press("Enter");
  await expect(
    page.getByText(/Hitchiner|No matching companies|No companies/i).first(),
  ).toBeVisible();

  await page.goto("/data-sources");
  await expect(
    page.getByRole("heading", { name: /data sources/i }),
  ).toBeVisible();
});
