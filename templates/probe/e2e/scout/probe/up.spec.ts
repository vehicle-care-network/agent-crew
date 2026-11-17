import { expect, test } from '@playwright/test';

/**
 * Production probes: is the live site serving? Plain Playwright against PROBE_BASE_URL, run by
 * .github/workflows/scout-probe.yml every 15 minutes with no data of its own. Keep these read-only and
 * few: they prove the service and what it depends on are up, nothing more. Scout never runs or edits them.
 */
test.describe('Probe', () => {
  test('the home page is served', async ({ page }) => {
    const res = await page.goto('/');
    expect(res?.status(), 'the page answers 200').toBe(200);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });
});
