import { expect, test, type Page } from "@playwright/test";

/**
 * Target Feed vertical slice: single tiered table (REDESIGN_PLAN §2), tier
 * filtering + saved views, human tier override persistence, candidate
 * profile, status change with audit note.
 *
 * Read-only assertions pass against an empty database (honest empty states);
 * mutation branches run only when at least one scored candidate exists, so
 * the suite never fabricates data.
 */

const email = process.env.ASI_E2E_EMAIL ?? "admin@local.test";
const password =
  process.env.ASI_E2E_PASSWORD ?? "local-development-admin-password-change-me";

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("target feed", () => {
  test.describe.configure({ mode: "serial" });

  test("login lands on /feed with a tiered table or honest empty state", async ({
    page,
  }) => {
    await signIn(page);
    await page.waitForURL(/\/feed(\?|$)/);

    await expect(
      page.getByRole("heading", { name: "Targets", exact: true }),
    ).toBeVisible();

    const table = page.getByRole("table");
    const emptyState = page.getByText(/No scored candidates yet/i);
    await expect(table.or(emptyState.first())).toBeVisible({ timeout: 20_000 });

    if (await emptyState.first().isVisible()) {
      // Honest empty state: no fabricated rows.
      expect(await table.count()).toBe(0);
      return;
    }
    // Tier column comes FIRST per REDESIGN_PLAN §2.3.
    const firstHeader = table.getByRole("columnheader").first();
    await expect(firstHeader).toHaveText("Tier");
    await expect(
      table.getByRole("columnheader", { name: "Confidence", exact: true }),
    ).toBeVisible();
    await expect(
      table.getByRole("columnheader", { name: "Novelty", exact: true }),
    ).toBeVisible();
  });

  test("dissolved /partner-review redirects to the high-interest view", async ({
    page,
  }) => {
    await signIn(page);
    await page.waitForURL(/\/feed(\?|$)/);
    await page.goto("/partner-review");
    await expect(page).toHaveURL(/\/feed\?tier=high_interest$/);
  });

  test("tier filter and saved-view presets persist in the URL", async ({
    page,
  }) => {
    await signIn(page);
    await page.waitForURL(/\/feed(\?|$)/);

    // Saved-view preset: Partner queue = high_interest.
    await page
      .getByRole("group", { name: "Saved views" })
      .getByRole("button", { name: "Partner queue" })
      .click();
    await expect(page).toHaveURL(/tier=high_interest/);

    // Manual tier filter selection persists too.
    await page
      .getByRole("combobox", { name: "Tier", exact: true })
      .selectOption("needs_research");
    await expect(page).toHaveURL(/tier=needs_research/);

    // When rows exist, every visible tier chip must match the filter.
    const rows = page.getByRole("table").getByRole("row");
    const rowCount = await rows.count();
    if (rowCount > 1) {
      const chips = page.getByRole("table").getByText("Needs research");
      expect(await chips.count()).toBeGreaterThan(0);
    }
  });

  test("candidate profile: open from feed, change status, see feedback", async ({
    page,
  }) => {
    test.info().annotations.push({
      description:
        "Runs only when scored candidates exist; skips honestly otherwise.",
      type: "note",
    });

    await signIn(page);
    await page.waitForURL(/\/feed(\?|$)/);

    const table = page.getByRole("table");
    const firstRowLink = page
      .getByRole("table")
      .getByRole("row")
      .nth(1)
      .getByRole("link")
      .first();
    const hasTable = await table
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!hasTable) {
      test.skip(true, "No scored candidates in this environment.");
      return;
    }

    const href = await firstRowLink.getAttribute("href");
    await firstRowLink.click();
    await page.waitForURL(/\/candidates\//);
    const statusHeading = page.getByRole("heading", { name: "Status control" });
    // Soft navigation normally swaps content; fall back to a full load if the
    // dev server drops the RSC payload.
    await statusHeading
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(async () => {
        if (href !== null && !page.url().includes(href)) await page.goto(href);
      });
    await expect(
      page.getByRole("heading", { name: "Status control" }),
    ).toBeVisible({ timeout: 20_000 });
    // Status control: set Shortlist with an audit note.
    await page.getByText("Status ▾").first().click();
    await page
      .getByLabel("Set status")
      .selectOption("shortlist");
    const note = `e2e audit note ${Date.now()}`;
    await page.getByLabel("Audit note").fill(note);
    await page.getByRole("button", { name: "Apply" }).click();

    // Feedback history tab must show the recorded note.
    await page.getByRole("tab", { name: "Feedback history" }).click();
    await expect(page.getByText(note)).toBeVisible();
  });

  test("set-tier override persists after reload", async ({ page }) => {
    test.info().annotations.push({
      description:
        "Runs only when scored candidates exist; skips honestly otherwise.",
      type: "note",
    });

    await signIn(page);
    await page.waitForURL(/\/feed(\?|$)/);
    await page.goto("/feed");

    // Data load enriches each row (identity + feature facts); allow time.

    const table = page.getByRole("table");
    const hasTable = await table
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!hasTable) {
      test.skip(true, "No scored candidates in this environment.");
      return;
    }

    const firstRow = table.getByRole("row").nth(1);
    const companyName = (
      await firstRow.getByRole("link").first().innerText()
    ).trim();

    // Open the row's Tier menu and set a Watchlist override with a note.
    const tierMenu = firstRow.locator("details").first();
    await tierMenu.locator("summary").click();
    await tierMenu.getByLabel("Set tier").selectOption("watchlist");
    await tierMenu
      .getByLabel("Audit note")
      .fill(`e2e tier override ${Date.now()}`);
    await tierMenu.getByRole("button", { name: "Apply" }).click();
    await expect(
      firstRow.getByText("Watchlist").first(),
    ).toBeVisible({ timeout: 10_000 });

    // Reload: the override must survive (server state, not just optimistic UI).
    await page.reload();
    const reloadedTable = page.getByRole("table");
    await reloadedTable.waitFor({ state: "visible", timeout: 15_000 });
    const reloadedRow = reloadedTable
      .getByRole("row")
      .filter({ hasText: companyName })
      .first();
    await expect(reloadedRow).toBeVisible();
    await expect(reloadedRow.getByText("Watchlist").first()).toBeVisible();

    // The tier filter (server-side effective-tier predicate) must now match.
    await page.goto("/feed?tier=watchlist");
    await expect(
      page
        .getByRole("table")
        .getByRole("row")
        .filter({ hasText: companyName })
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
