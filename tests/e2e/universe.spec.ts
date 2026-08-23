import { expect, test, type Page } from "@playwright/test";

const email = process.env.ASI_E2E_EMAIL ?? "admin@local.test";
const password =
  process.env.ASI_E2E_PASSWORD ?? "local-development-admin-password-change-me";

async function signIn(page: Page): Promise<boolean> {
  // The login form is client-rendered; a click before hydration falls through
  // to a native GET submit (credentials leak into the query string). Retry
  // until the fetch-based handler wins the race.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto("/login", { waitUntil: "networkidle" });
    await page.getByLabel("Username").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    try {
      await page.waitForURL(/\/(dashboard|feed)$/, { timeout: 10_000 });
      return true;
    } catch {
      if (!page.url().includes("/login")) return false;
    }
  }
  return false;
}

test.describe("universe consolidation", () => {
  test("sub-tabs recompose companies, identity review, golden set, sources", async ({
    page,
  }) => {
    const signedIn = await signIn(page);
    test.skip(
      !signedIn,
      "requires local admin credentials (set ASI_E2E_EMAIL/ASI_E2E_PASSWORD)",
    );

    // Default tab: Companies (company explorer + known-universe browser).
    await page.goto("/universe");
    const tablist = page.getByRole("tablist", { name: "Universe sections" });
    await expect(tablist).toBeVisible();
    await expect(
      tablist.getByRole("tab", { name: "Companies" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/universe$/);

    // Companies tab mounts the existing company catalog explorer.
    await expect(page.getByText("Find supplier entities")).toBeVisible();

    // Identity review tab is URL-persisted and mounts the queue + merges.
    await tablist.getByRole("tab", { name: "Identity review" }).click();
    await expect(page).toHaveURL(/\/universe\?tab=identity-review$/);
    await expect(
      page.getByRole("tab", { name: "Identity review" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("heading", { name: "Probable-match queue" }),
    ).toBeVisible();
    await expect(
      page.getByText("Persisted company merge and revert history."),
    ).toBeVisible();

    // Deep link straight into a sub-tab.
    await page.goto("/universe?tab=golden-set");
    await expect(
      page.getByRole("tab", { name: "Golden Set" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("columnheader", { name: "Company" }),
    ).toBeVisible();

    // Sources tab mounts the data-source explorer.
    await page.goto("/universe?tab=sources");
    await expect(
      page.getByRole("tab", { name: "Sources" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("link", { name: "Add source" }),
    ).toBeVisible();

    // Unknown tab values fall back to Companies.
    await page.goto("/universe?tab=bogus");
    await expect(
      page.getByRole("tab", { name: "Companies" }),
    ).toHaveAttribute("aria-selected", "true");

    // Nav entry points at the page.
    await page.goto("/dashboard");
    await expect(
      page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Universe", exact: true }),
    ).toBeVisible();
  });
});
