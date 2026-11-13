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
    await expect(pills).toHaveCount(3);

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

  test('converts with zero external network requests', async ({ page }) => {
    // Runtime proof of the "100% local" guarantee: the page, its assets, the
    // conversion worker and the image all come from the same origin (or
    // blob:/data:). No request may leave for any external origin.
    const requests: string[] = [];
    page.on('request', (req) => requests.push(req.url()));

    await page.goto('/');
    await page.setInputFiles('#single-file-input', fixture);
    await expect(page.locator('#single-result')).toBeVisible({ timeout: 15_000 });

    const sameOrigin = new URL(page.url()).origin;
    const foreign = requests.filter((url) => {
      const parsed = new URL(url);
      const isSameOrigin = parsed.origin === sameOrigin;
      const isInMemory = parsed.protocol === 'blob:' || parsed.protocol === 'data:';
      return !isSameOrigin && !isInMemory;
    });
    expect(foreign).toEqual([]);
  });

  test('run-it-locally section installs, switches tabs and copies', async ({ page }) => {
    await page.goto('/');

    const local = page.locator('#local');
    await expect(local).toBeVisible();
    await expect(page.locator('#install-tabs [role="tab"]')).toHaveCount(3);

    // Exactly one panel is open, whichever the platform default picked
    // (covered by the unit test; the runner may be Windows or Linux).
    await expect(page.locator('.tabpanel:visible')).toHaveCount(1);

    await page.locator('#local-tab-unix').click();
    await expect(page.locator('#local-panel-unix')).toBeVisible();
    await expect(page.locator('#cmd-unix-install')).toContainText(
      'releases/download/rust-latest/install.sh',
    );

    await page.locator('#local-tab-windows').click();
    await expect(page.locator('#local-panel-windows')).toBeVisible();
    await expect(page.locator('#local-panel-unix')).toBeHidden();
    await expect(page.locator('#local-tab-windows')).toHaveAttribute('aria-selected', 'true');

    await page.locator('#local-panel-windows .copy-btn').first().click();
    await expect(page.locator('#local-panel-windows .copy-btn').first()).toHaveText('Copied');

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('install.ps1');
    expect(clipboard).toContain('-Json');
  });

  test('section nav anchors resolve to sections', async ({ page }) => {
    await page.goto('/');

    const link = page.locator('.section-nav a[href="#local"]');
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/#local$/);
  });
});
