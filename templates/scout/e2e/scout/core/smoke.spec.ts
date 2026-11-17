import { expect } from '@playwright/test';
import { evidence, loginAs, test } from '../_support/scout';

/**
 * The baseline Scout runs on every PR before any flow of the PR's own: if these fail, the app itself is
 * down and nothing after them means much. Keep them few and fast.
 */
test.describe('Smoke', () => {
  test('the home page loads', async ({ page }, testInfo) => {
    const res = await page.goto('/');
    expect(res?.status(), 'the page answers').toBeLessThan(400);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await evidence(page, testInfo, 'the home page');
  });

  test('the seeded user signs in', async ({ page }, testInfo) => {
    await loginAs(page);
    await evidence(page, testInfo, 'signed in as the seeded user');
  });
});
