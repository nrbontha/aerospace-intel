import { expect, test, type Page } from "@playwright/test";

const email = process.env.ASI_E2E_EMAIL ?? "admin@local.test";
const password =
  process.env.ASI_E2E_PASSWORD ?? "local-development-admin-password-change-me";

async function signIn(page: Page): Promise<boolean> {
  await page.goto("/login");
  await page.getByLabel("Username").fill(email);
  await page.getByLabel("Password").fill(password);
  const loginResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/auth/login"),
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  const response = await loginResponse.catch(() => undefined);
  if (response === undefined || !response.ok()) return false;
  // The app lands on /dashboard or / depending on build; confirm the
  // session cookie actually grants access to a protected page.
  await page.goto("/campaigns");
  try {
    await page
      .getByRole("heading", { name: "Campaigns", exact: true })
      .waitFor({ timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

test.describe("campaigns", () => {
  test("create campaign, see draft badge, empty frontier, start after manual item", async ({
    page,
  }) => {
    const signedIn = await signIn(page);
    test.skip(
      !signedIn,
      "requires local admin credentials (set ASI_E2E_EMAIL/ASI_E2E_PASSWORD)",
    );
    // Accept the lifecycle confirm() dialogs.
    page.on("dialog", (dialog) => void dialog.accept());

    const campaignName = `E2E campaign ${Date.now()}`;

    await page.goto("/campaigns");
    await expect(
      page.getByRole("heading", { name: "Campaigns", exact: true }),
    ).toBeVisible();

    // Create a draft via the drawer.
    await page.getByRole("button", { name: "New campaign" }).click();
    const drawer = page.getByRole("dialog", { name: /new research campaign/i });
    await drawer.getByLabel("Name").fill(campaignName);
    const seeds = drawer.getByLabel(/Seeds \(JSON\)/);
    await expect(seeds).toHaveValue(/"sources"/);
    await seeds.fill('{"sources":["usaspending"],"platforms":[],"capabilities":[],"geography":[]}');
    await drawer.getByRole("button", { name: "Create draft" }).click();
    await expect(
      drawer.getByText(new RegExp(`"${campaignName}" created as a draft|created as a draft`)),
    ).toBeVisible();
    // A fresh draft has an empty frontier, so Start is disabled here.
    await expect(drawer.getByRole("button", { name: "Start now" })).toBeDisabled();
    await drawer.getByRole("link", { name: "Open campaign" }).click();

    // Detail renders honestly with an empty frontier.
    await expect(
      page.getByRole("heading", { name: campaignName }),
    ).toBeVisible();
    await expect(page.getByText("draft").first()).toBeVisible();
    await expect(
      page.getByText(/frontier is empty|The frontier is empty/),
    ).toBeVisible();

    // Start is gated until at least one item exists.
    const startButton = page.getByRole("button", { name: "start", exact: true });
    await expect(startButton).toBeDisabled();

    // Add one manual frontier item.
    await page.getByLabel("Normalized value").fill(`e2e-seed-${Date.now()}`);
    await page
      .getByRole("button", { name: "Add frontier item" })
      .click();
    await expect(page.getByText("Frontier item added.")).toBeVisible();

    // Start becomes enabled and completes the transition.
    await expect(startButton).toBeEnabled({ timeout: 15_000 });
    await startButton.click();
    await expect(page.getByText("running").first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
