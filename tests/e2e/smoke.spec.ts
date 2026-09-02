import { test, expect } from "@playwright/test";

// Full authenticated flows (sign in -> subscribe -> comment -> sign out;
// admin sign-in -> toggle install -> trigger scan) need real Google OAuth
// credentials, which this environment doesn't have -- they're covered
// instead by the Server Action integration tests (npm run test), which
// exercise the same requireUser/requireAdmin-gated logic directly against
// the database with a mocked session. What follows is everything reachable
// without a live OAuth round-trip.

test("home page redirects to /calendar", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/calendar/);
});

test("browse: calendar tab renders seeded events for the correct month", async ({ page }) => {
  await page.goto("/calendar?tab=upcoming");
  await expect(page.getByText("Release Watcher")).toBeVisible();
  await expect(page.locator("ul button").first()).toBeVisible();
});

test("filter: narrowing by search excludes non-matching events", async ({ page }) => {
  await page.goto("/calendar?tab=upcoming");
  await expect(page.locator("ul button").first()).toBeVisible();

  await page.getByPlaceholder("Product set name…").fill("zzz-definitely-no-match");
  await page.keyboard.press("Enter");

  await expect(page.getByText("Nothing upcoming in the next 90 days.")).toBeVisible();
});

test("view detail: clicking an event opens the drawer with its source claims section", async ({ page }) => {
  await page.goto("/calendar?tab=upcoming");
  await page.locator("ul button").first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Source claims/)).toBeVisible();
  await expect(dialog.getByText(/Comments/)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
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
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
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
