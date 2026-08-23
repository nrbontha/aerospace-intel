import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Campaigns after the nav collapse (REDESIGN_PLAN §3/§5): the /campaigns list
 * page is retired (redirects to /research, whose campaigns strip lists them)
 * but campaign detail — frontier curation and lifecycle — stays live at
 * /campaigns/[id]. Drafts are created through the audited API.
 */

const email = process.env.ASI_E2E_EMAIL ?? "admin@local.test";
const password =
  process.env.ASI_E2E_PASSWORD ?? "local-development-admin-password-change-me";

async function signIn(page: Page): Promise<boolean> {
  // Sign in through the audited API so session cookies land directly in the
  // browser context — immune to client-hydration races on /login.
  const response = await page.request.post("/api/v1/auth/login", {
    data: { username: email, password },
  });
  if (!response.ok()) return false;
  await page.goto("/feed");
  return true;
}

async function createCampaignDraft(
  page: Page,
  name: string,
): Promise<{ status: number; body: string }> {
  const origin = new URL(
    process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
  ).origin;
  const state = await page.request.storageState();
  const csrf = state.cookies.find((cookie) => cookie.name.endsWith("_csrf"))
    ?.value;
  const response = await page.request.post("/api/v1/campaigns", {
    headers: {
      "content-type": "application/json",
      origin,
      ...(csrf !== undefined ? { "x-csrf-token": csrf } : {}),
    },
    data: {
      name,
      seeds: {
        sources: ["usaspending"],
        platforms: [],
        capabilities: [],
        geography: [],
      },
    },
  });
  return { status: response.status(), body: await response.text() };
}

function campaignIdOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("data" in body)) {
    return undefined;
  }
  const data: unknown = body.data;
  if (
    typeof data === "object" &&
    data !== null &&
    "id" in data &&
    typeof data.id === "string"
  ) {
    return data.id;
  }
  return undefined;
}

test.describe("campaigns", () => {
  test("create draft via API, see it in the research strip, run it", async ({
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

    // Retired list route lands on the Research control plane.
    await page.goto("/campaigns");
    await expect(page).toHaveURL(/\/research$/);
    await expect(
      page.getByRole("heading", { name: "Research", exact: true }),
    ).toBeVisible();

    // Create a draft through the audited campaigns API.
    const created = await createCampaignDraft(page, campaignName);
    expect(created.status, `campaign create failed: ${created.body}`).toBe(201);
    const campaignId = campaignIdOf(JSON.parse(created.body) as unknown);
    if (campaignId === undefined) {
      throw new Error(`No id in create response: ${created.body}`);
    }

    // The research campaigns strip lists the new draft.
    await page.goto("/research");
    const strip = page.getByTestId("campaigns-strip");
    await expect(strip).toBeVisible();
    await expect(
      strip.getByRole("link", { name: campaignName }),
    ).toBeVisible();

    await page.goto(`/campaigns/${campaignId}`);
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
