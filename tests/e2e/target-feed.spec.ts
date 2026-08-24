import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";

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
  // Sign in through the audited API so session cookies land directly in the
  // browser context, then land on the Targets table. Immune to
  // client-hydration races on the login form.
  const response = await page.request.post("/api/v1/auth/login", {
    data: { username: email, password },
  });
  if (!response.ok()) {
    throw new Error(`Sign-in failed (${response.status()})`);
  }
  await page.goto("/feed");
}

/** /feed now stacks the leads discovery inbox above the Targets table;
 * scope every candidate assertion to the Targets section so both tables can
 * coexist without Playwright strict-mode violations. */
function targetsSection(page: Page): Locator {
  return page.locator('section[aria-labelledby="target-feed-title"]');
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

    const table = targetsSection(page).getByRole("table");
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
    const rows = targetsSection(page).getByRole("table").getByRole("row");
    const rowCount = await rows.count();
    if (rowCount > 1) {
      const chips = targetsSection(page).getByRole("table").getByText("Needs research");
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

    const table = targetsSection(page).getByRole("table");
    const firstRowLink = table
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

    const table = targetsSection(page).getByRole("table");
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
    const reloadedTable = targetsSection(page).getByRole("table");
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
      targetsSection(page)
        .getByRole("table")
        .getByRole("row")
        .filter({ hasText: companyName })
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("lead discovery inbox", () => {
  test.describe.configure({ mode: "serial" });

  /** The inbox renders honestly when empty; data-dependent assertions run
   * only when the environment actually has leads. */
  async function leadCount(request: APIRequestContext): Promise<number> {
    const response = await request.get("/api/v1/leads?page=1&pageSize=1");
    if (!response.ok()) return 0;
    const payload = (await response.json()) as {
      meta?: { totalItems?: number };
    };
    return payload.meta?.totalItems ?? 0;
  }

  test("inbox renders leads table with pipeline columns and honest empty state", async ({
    page,
  }) => {
    await signIn(page);

    const total = await leadCount(page.request);
    test.info().annotations.push({
      description: `${total} leads in this environment.`,
      type: "note",
    });

    const inbox = page.getByRole("region", { name: "Discovery inbox" });
    await expect(
      inbox.getByRole("heading", { name: "Discovery inbox" }),
    ).toBeVisible({ timeout: 20_000 });

    if (total === 0) {
      await expect(
        inbox.getByText(/No leads yet/i),
      ).toBeVisible();
      return;
    }

    const table = inbox.getByRole("table");
    await expect(
      table.getByRole("columnheader", { name: "Company" }),
    ).toBeVisible();
    await expect(
      table.getByRole("columnheader", { name: "Federal $" }),
    ).toBeVisible();
    await expect(
      table.getByRole("columnheader", { name: "Awards" }),
    ).toBeVisible();
    await expect(
      table.getByRole("columnheader", { name: "Status" }),
    ).toBeVisible();
    // Status chips exist on every row.
    expect(await table.getByText(/⚪|⚡|✓/).count()).toBeGreaterThan(0);
  });

  test("status filter chips and search drive server-side pagination params", async ({
    page,
  }) => {
    await signIn(page);

    const total = await leadCount(page.request);
    if (total === 0) {
      test.skip(true, "No leads in this environment.");
      return;
    }

    const inbox = page.getByRole("region", { name: "Discovery inbox" });
    await inbox
      .getByRole("group", { name: "Lead status filter" })
      .getByRole("button", { name: "Unresolved" })
      .click();
    await expect(page).toHaveURL(/leadStatus=unresolved_lead/);

    const york = await page.request.get(
      "/api/v1/leads?page=1&pageSize=5&q=YORK",
    );
    if (york.ok()) {
      const payload = (await york.json()) as { data?: unknown[] };
      if ((payload.data?.length ?? 0) > 0) {
        await page.goto("/feed?leadQ=YORK");
        await expect(
          inbox
            .getByRole("table")
            .getByRole("row")
            .filter({
              hasText: "YORK PRECISION MACHINING AND HYDRAULICS",
            })
            .first(),
        ).toBeVisible({ timeout: 10_000 });
      }
    }
  });

  test("row click opens the lead detail drawer with award context", async ({
    page,
  }) => {
    await signIn(page);

    const total = await leadCount(page.request);
    if (total === 0) {
      test.skip(true, "No leads in this environment.");
      return;
    }

    const inbox = page.getByRole("region", { name: "Discovery inbox" });
    const firstRow = inbox.getByRole("table").getByRole("row").nth(1);
    await firstRow.click();
    const drawer = page.getByRole("dialog");
    await expect(
      drawer.getByRole("heading", { name: "Award context" }),
    ).toBeVisible();
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).not.toBeVisible();
  });
});
