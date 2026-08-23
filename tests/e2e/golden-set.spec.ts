import { expect, test, type Page } from "@playwright/test";

const email = process.env.ASI_E2E_EMAIL ?? "admin@local.test";
const password =
  process.env.ASI_E2E_PASSWORD ??
  "local-development-admin-password-change-me";

async function signIn(page: Page): Promise<boolean> {
  await page.goto("/login");
  await page.getByLabel("Username").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  try {
    await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
test.describe("golden set review", () => {
  test("review flow: rows, panel, rationale guard, submit", async ({
    page,
  }) => {
    const signedIn = await signIn(page);
    test.skip(
      !signedIn,
      "requires local admin credentials (set ASI_E2E_EMAIL/ASI_E2E_PASSWORD)",
    );

    await page.goto("/golden-set");
    await expect(
      page.getByRole("heading", { name: "Golden Set" }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Company" }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Proposed" }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Reviewed" }),
    ).toBeVisible();

    const rows = page.locator("tbody tr");
    await expect(rows).toHaveCount(18);

    // Keyboard: ArrowDown moves row focus, Enter opens the review panel.
    await rows.first().focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const panel = page.getByRole("complementary", { name: /details/ });
    await expect(panel).toBeVisible();

    // Empty/too-short rationale blocks submission.
    const rationale = panel.getByLabel(/Review rationale/);
    await rationale.fill("too short");
    await panel.getByRole("button", { name: "Submit review" }).click();
    await expect(panel.getByRole("alert")).toContainText(
      "at least 10 characters",
    );

    // Valid submit flips the status badge to reviewed.
    await rationale.fill("Confirmed against the golden-set qualifying criteria.");
    await panel.getByRole("button", { name: "Submit review" }).click();
    await expect(page.locator("tbody tr").first()).toContainText("reviewed");
  });
});
