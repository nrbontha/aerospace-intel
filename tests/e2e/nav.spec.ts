import { expect, test, type Page } from "@playwright/test";

/**
 * Collapsed navigation (REDESIGN_PLAN §5): four top-level entries only —
 * Targets | Research | Universe | Admin ▾ — with every retired left-nav route
 * served as a redirect into its surviving surface.
 */

const email = process.env.ASI_E2E_EMAIL ?? "admin@local.test";
const password =
  process.env.ASI_E2E_PASSWORD ?? "local-development-admin-password-change-me";

async function signIn(page: Page): Promise<void> {
  // Sign in through the audited API so the session cookies land directly in
  // the browser context — immune to client-hydration races on /login.
  const response = await page.request.post("/api/v1/auth/login", {
    data: { username: email, password },
  });
  if (!response.ok()) {
    throw new Error(`Sign-in failed (${response.status()})`);
  }
}

test.describe("collapsed navigation", () => {
  test("shows exactly Targets | Research | Universe | Admin", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/feed");
    const nav = page.getByRole("navigation", {
      name: "Primary navigation",
    });
    const topLevelItems = nav.locator("ul").first().locator(":scope > li");
    await expect(topLevelItems).toHaveCount(4);

    // The three top-level destinations render as plain links.
    for (const label of ["Targets", "Research", "Universe"]) {
      await expect(
        nav.locator("ul").first().locator(":scope > li > a", { hasText: label }),
      ).toBeVisible();
    }

    const summary = nav.locator("summary", { hasText: "Admin" });
    await expect(summary).toBeVisible();
    await expect(nav.getByRole("link", { name: "Experiments" })).toBeHidden();
    await expect(nav.getByRole("link", { name: "Imports" })).toBeHidden();
    await expect(
      nav.getByRole("link", { name: "Users & access" }),
    ).toBeHidden();

    // Retired entries are gone from the nav entirely.
    for (const retired of [
      "Companies",
      "Facilities",
      "Data Sources",
      "Golden Set",
      "Known Universe",
      "Campaigns",
      "Platforms",
      "Parts",
      "Subsystems",
      "Customers",
      "Qualifications",
      "Capabilities",
      "Certifications",
      "Target Feed",
      "Merges",
      "Research Queue",
      "Research Runs",
    ]) {
      await expect(
        nav.getByRole("link", { name: retired }),
      ).toHaveCount(0);
    }
  });

  test("admin disclosure reveals experiments, imports, users & access", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/feed");
    const nav = page.getByRole("navigation", {
      name: "Primary navigation",
    });
    await nav.locator("summary", { hasText: "Admin" }).click();

    await expect(nav.getByRole("link", { name: "Experiments" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Imports" })).toBeVisible();
    await expect(
      nav.getByRole("link", { name: "Users & access" }),
    ).toBeVisible();
  });

  test("top-level tabs render their headings", async ({ page }) => {
    await signIn(page);
    await page.goto("/feed");
    const nav = page.getByRole("navigation", {
      name: "Primary navigation",
    });

    await nav.getByRole("link", { name: "Targets" }).click();
    await expect(page).toHaveURL(/\/feed$/);
    await expect(
      page.getByRole("heading", { name: "Targets", exact: true }),
    ).toBeVisible();

    await nav.getByRole("link", { name: "Research" }).click();
    await expect(page).toHaveURL(/\/research$/);
    await expect(
      page.getByRole("heading", { name: "Research", exact: true }),
    ).toBeVisible();

    await nav.getByRole("link", { name: "Universe" }).click();
    await expect(page).toHaveURL(/\/universe$/);
    // Universe lands on its default sub-tab.
    await expect(
      page.getByRole("heading", { name: "Companies", exact: true }),
    ).toBeVisible();
  });

  test("/dashboard redirects to /feed", async ({ page }) => {
    await signIn(page);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/feed$/);
    await expect(
      page.getByRole("heading", { name: "Targets", exact: true }),
    ).toBeVisible();
  });

  test("/partner-review redirects to the high-interest feed view", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/partner-review");
    await expect(page).toHaveURL(/\/feed\?tier=high_interest$/);
  });

  test("/research-queue redirects to the needs-research feed view", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/research-queue");
    await expect(page).toHaveURL(/\/feed\?tier=needs_research$/);
  });

  test("/merges redirects to universe identity review", async ({ page }) => {
    await signIn(page);
    await page.goto("/merges");
    await expect(page).toHaveURL(/\/universe\?tab=identity-review$/);
    await expect(
      page.getByRole("tab", { name: "Identity review" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  test("/golden-set redirects to universe golden set", async ({ page }) => {
    await signIn(page);
    await page.goto("/golden-set");
    await expect(page).toHaveURL(/\/universe\?tab=golden-set$/);
    await expect(
      page.getByRole("tab", { name: "Golden Set" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("heading", { name: "Golden Set", exact: true }),
    ).toBeVisible();
  });

  test("/data-sources redirects to universe sources", async ({ page }) => {
    await signIn(page);
    await page.goto("/data-sources");
    await expect(page).toHaveURL(/\/universe\?tab=sources$/);
    await expect(
      page.getByRole("tab", { name: "Sources" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  test("/campaigns and /research-runs redirect to research", async ({
    page,
  }) => {
    await signIn(page);

    await page.goto("/campaigns");
    await expect(page).toHaveURL(/\/research$/);
    await expect(
      page.getByRole("heading", { name: "Research", exact: true }),
    ).toBeVisible();

    await page.goto("/research-runs");
    await expect(page).toHaveURL(/\/research$/);
  });

  test("/admin hub links the admin surfaces", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "Admin", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Users & access" }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(
      page.getByRole("heading", { name: "User access", exact: true }),
    ).toBeVisible();
  });
});
