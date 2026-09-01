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
    // Browser-only "Save to Folder" is hidden for the server edition.
    await expect(page.locator('#save-folder-btn')).toBeHidden();

    // The server edition must load under its CSP with connect-src 'self'.
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("connect-src 'self'");
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