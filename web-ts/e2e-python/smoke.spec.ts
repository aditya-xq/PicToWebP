import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'e2e', 'fixtures', 'sample.png');

test.describe('PicToWebP unified SPA over the Python backend', () => {
  test('loads the local-server edition with python-only options', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/PicToWebP/);

    // The python build enables lossless/metadata controls and the server file browser.
    await expect(page.locator('#edition-badge')).toHaveText('Local Server');
    await expect(page.locator('#toggle-lossless')).toBeVisible();
    await expect(page.locator('#toggle-metadata')).toBeVisible();

    // The server edition must load under its CSP with connect-src 'self'.
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("connect-src 'self'");
  });

  test('editions section follows the backend capabilities', async ({ page }) => {
    await page.goto('/');

    // Same markup as the static build; the highlight and the notes come from
    // the backend capabilities rather than from a per-profile template.
    // The page lists the browser and CLI editions only; the Python server is a
    // contributor path, so nothing is highlighted when it serves this page.
    await expect(page.locator('.edition-card')).toHaveCount(2);
    await expect(page.locator('.edition-card.is-current')).toHaveCount(0);
    await expect(page.locator('[data-when="metadata"]')).toBeHidden();
    await expect(page.locator('[data-when="lossless"]')).toBeHidden();

    // Install instructions must still be present in the served edition.
    await expect(page.locator('#install-tabs [role="tab"]')).toHaveCount(2);
    await expect(page.locator('#cmd-skills')).toContainText('npx skills add');
  });

  test('converts a single image through the server API', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#single-file-input', fixture);

    const result = page.locator('#single-result');
    await expect(result).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#single-result-info')).toContainText('smaller');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#single-download-btn').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.webp$/);
  });
});