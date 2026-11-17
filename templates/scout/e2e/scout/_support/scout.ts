import { test as base, expect, Locator, Page, TestInfo } from '@playwright/test';

/**
 * Use this `test` in every Scout spec instead of Playwright's. It records browser console errors and
 * failed same-origin requests (status >= 500) on each test, and attaches them as `scout-console`, which
 * the PR report lists per flow. They are reported, not failed on: the agent decides whether one matters.
 */
export const test = base.extend<{ consoleWatch: void }>({
  consoleWatch: [
    async ({ page }, use, testInfo) => {
      const problems: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') problems.push(`console: ${msg.text().slice(0, 300)}`);
      });
      page.on('pageerror', (err) => problems.push(`page error: ${err.message.slice(0, 300)}`));
      page.on('response', (res) => {
        if (res.status() >= 500 && res.url().startsWith(testInfo.project.use.baseURL ?? '')) {
          problems.push(`HTTP ${res.status()}: ${res.request().method()} ${new URL(res.url()).pathname}`);
        }
      });
      await use();
      if (problems.length) await testInfo.attach('scout-console', { body: problems.join('\n'), contentType: 'text/plain' });
    },
    { auto: true },
  ],
});

/** Must match `SCOUT` in `scripts/scout/fixtures.mjs`, which the base seed uses. */
export const SCOUT = {
  password: 'scout-password-123',
  userEmail: 'user@scout.test',
};

/**
 * Signs a seeded account in and waits until the app shows it is signed in.
 * TODO: make this match your app's sign-in page. The selectors below are a common shape, not yours.
 * Scout signs in through the Auth emulator, so the app must offer an email and password form there
 * (many apps show one only when NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST is set).
 */
export async function loginAs(page: Page, email: string = SCOUT.userEmail, password = SCOUT.password) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  // Something only a signed-in person sees.
  await expect(page.getByRole('button', { name: /sign out|account/i }).first()).toBeVisible({ timeout: 30 * 1000 });
}

/** A part of the page this PR changed, outlined on the screenshot so a reviewer knows where to look. */
export type Highlight = Locator | { locator: Locator; label: string };

/**
 * Attaches a named full-page screenshot to the test. The PR comment lists these in order, so name
 * each one for what it proves ("reschedule modal shows new slot"), not for where it was taken.
 *
 * `highlight`: the elements this PR changed or that prove the point. Each gets a numbered outline and
 * label drawn on the screenshot (and removed right after), so the reviewer sees at once where to look.
 * Elements that aren't on the page are skipped rather than failing the test.
 */
export async function evidence(page: Page, testInfo: TestInfo, name: string, highlight: Highlight[] = []) {
  const boxes: { x: number; y: number; width: number; height: number; label: string }[] = [];
  for (const [i, h] of highlight.entries()) {
    const { locator, label } = 'label' in h ? h : { locator: h, label: '' };
    const box = await locator
      .first()
      .boundingBox({ timeout: 2000 })
      .catch(() => null);
    if (box && box.width > 0 && box.height > 0) boxes.push({ ...box, label: `${i + 1}${label ? ` · ${label}` : ''}` });
  }
  if (boxes.length) {
    // Bounding boxes are relative to the viewport; the overlay sits in the document, so add the scroll.
    await page.evaluate((list) => {
      const root = document.createElement('div');
      root.id = '__scout_highlights';
      root.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2147483647';
      for (const b of list) {
        const ring = document.createElement('div');
        ring.style.cssText = `position:absolute;left:${b.x + scrollX - 4}px;top:${b.y + scrollY - 4}px;width:${b.width + 8}px;height:${b.height + 8}px;border:3px solid #ff2d75;border-radius:8px;box-shadow:0 0 0 3px rgba(255,255,255,.85),0 0 18px rgba(255,45,117,.45)`;
        const tag = document.createElement('div');
        tag.textContent = b.label;
        tag.style.cssText = `position:absolute;left:${b.x + scrollX - 4}px;top:${Math.max(0, b.y + scrollY - 30)}px;background:#ff2d75;color:#fff;font:700 13px/1 system-ui,sans-serif;padding:6px 8px;border-radius:6px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.25)`;
        root.append(ring, tag);
      }
      document.body.append(root);
    }, boxes);
  }
  const body = await page.screenshot({ fullPage: true });
  if (boxes.length) await page.evaluate(() => document.getElementById('__scout_highlights')?.remove());
  await testInfo.attach(name, { body, contentType: 'image/png' });
}
