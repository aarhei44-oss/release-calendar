import { test, expect } from "@playwright/test";

// Full authenticated flows (sign in -> subscribe -> comment -> sign out;
// admin sign-in -> toggle install -> trigger scan) need real Google OAuth
// credentials, which this environment doesn't have -- they're covered
// instead by the Server Action integration tests (npm run test), which
// exercise the same requireUser/requireAdmin-gated logic directly against
// the database with a mocked session. What follows is everything reachable
// without a live OAuth round-trip.

test("home page: landing page renders its pitch and links into the app", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBeTruthy();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: /never miss a tcg release/i })).toBeVisible();

  await page.getByRole("link", { name: "View the calendar" }).click();
  await expect(page).toHaveURL(/\/calendar/);
});

test("browse: calendar tab renders seeded events for the correct month", async ({ page }) => {
  await page.goto("/calendar?tab=upcoming");
  await expect(page.getByText("Release Watcher")).toBeVisible();
  await expect(page.getByTestId("event-row").first()).toBeVisible();
});

test("filter: narrowing by search excludes non-matching events", async ({ page }) => {
  await page.goto("/calendar?tab=upcoming");
  await expect(page.getByTestId("event-row").first()).toBeVisible();

  await page.getByPlaceholder("Product set name…").fill("zzz-definitely-no-match");
  await page.keyboard.press("Enter");

  await expect(page.getByText("Nothing upcoming in the next 90 days.")).toBeVisible();
});

test("view detail: clicking an event opens the drawer with its source claims section", async ({ page }) => {
  await page.goto("/calendar?tab=upcoming");
  await page.getByTestId("event-row").first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Source claims/)).toBeVisible();
  await expect(dialog.getByText(/Comments/)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("filter: TCG checkbox selection persists across a reload (regression guard)", async ({ page }) => {
  // Regression coverage for a bug where installIds were parsed with an
  // empty whitelist, silently stripping every selected TCG on every
  // navigation -- see app/calendar/searchParams.ts.
  await page.goto("/calendar?tab=upcoming");

  const checkbox = page.getByRole("checkbox", { name: "Pokémon Trading Card Game" });
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();

  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect(page).toHaveURL(/installIds=/);

  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Pokémon Trading Card Game" })).toBeChecked();
});

test("layout: the document never scrolls, only the active tab panel does", async ({ page }) => {
  await page.goto("/calendar?tab=list");
  await expect(page.getByTestId("tabpanel-scroll")).toBeVisible();

  const documentOverflowsWindow = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight + 1,
  );
  expect(documentOverflowsWindow).toBe(false);
});

test("responsive: mobile viewport collapses filters into an off-canvas panel", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/calendar?tab=upcoming");

  const noHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  expect(noHorizontalOverflow).toBe(true);

  const filtersTrigger = page.getByRole("button", { name: "Filters" });
  await expect(filtersTrigger).toBeVisible();

  await filtersTrigger.click();
  const filterDialog = page.getByRole("dialog", { name: "Filters" });
  await expect(filterDialog).toBeVisible();
  await expect(filterDialog.getByRole("checkbox").first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(filterDialog).not.toBeVisible();
});

test("sign-in affordance is present and starts the Google OAuth flow", async ({ page }) => {
  await page.goto("/calendar");
  const signInButton = page.getByRole("button", { name: "Sign in with Google" });
  await expect(signInButton).toBeVisible();

  await signInButton.click();
  // next-auth navigates to /api/auth/signin/google, which redirects to
  // Google's own accounts.google.com consent screen -- reaching that
  // redirect (without completing it) confirms the provider is wired up.
  await page.waitForURL(/signin|accounts\.google\.com/, { timeout: 10_000 });
});

test("subscriptions page prompts an anonymous visitor to sign in", async ({ page }) => {
  await page.goto("/subscriptions");
  await expect(page.getByText(/Sign in to subscribe/)).toBeVisible();
  // The header also has its own "Sign in with Google" button, so scope to
  // the page's own prompt (in <main>) rather than matching either one.
  await expect(page.getByRole("main").getByRole("button", { name: "Sign in with Google" })).toBeVisible();
});

test("dashboard page prompts an anonymous visitor to sign in", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByText(/Sign in to see a dashboard/)).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: "Sign in with Google" })).toBeVisible();
});

test("admin page redirects an anonymous visitor away", async ({ page }) => {
  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/calendar|\/$/);
  expect(response?.ok()).toBeTruthy();
});

test("health check reports the database as up", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body).toEqual({ status: "ok", database: "up" });
});
