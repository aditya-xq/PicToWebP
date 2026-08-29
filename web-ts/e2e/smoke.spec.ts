import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'sample.png');

test.describe('PicToWebP browser edition', () => {
  test('loads with privacy messaging and working quality slider', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/PicToWebP/);

    const pills = page.locator('.privacy-pill, .pill');
    await expect(pills).toHaveCount(4);

    const slider = page.locator('#quality-slider');
    await slider.fill('60');
    await expect(page.locator('#quality-value')).toHaveText('60');
  });

  test('converts a single image and offers the WebP download', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#single-file-input', fixture);

    const result = page.locator('#single-result');
    await expect(result).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#single-result-info')).toContainText('smaller');

    const preview = page.locator('#single-preview-img');
    await expect(preview).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#single-download-btn').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.webp$/);
  });
});
