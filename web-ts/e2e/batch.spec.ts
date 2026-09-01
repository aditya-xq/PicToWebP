import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const here = path.dirname(fileURLToPath(import.meta.url));
// The SAME fixture corpus every tool's E2E uses (tests/e2e/fixtures).
const fixtures = path.resolve(here, '..', '..', 'tests', 'e2e', 'fixtures');
const realImagesDir = path.resolve(here, '..', '..', 'tests', 'e2e', 'real_images');

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

function loadFixture(name: string): { name: string; buffer: Buffer; type: string } {
  return {
    name,
    buffer: fs.readFileSync(path.join(fixtures, name)),
    type: MIME[path.extname(name)] ?? 'application/octet-stream',
  };
}

function imageCount(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir, { recursive: true })
    .filter((n) => /\.(jpe?g|png|webp)$/i.test(n)).length;
}

/** Ensure the 500-photo realistic set exists (auto-downloads once, keeps it). */
function ensureRealDataset(): boolean {
  if (imageCount(realImagesDir) >= 500) return true;
  try {
    execFileSync(
      'uv',
      ['run', 'python', 'tests/e2e/download_real_dataset.py', '--count', '500'],
      { cwd: path.resolve(here, '..', '..'), stdio: 'ignore', timeout: 900_000 },
    );
  } catch {
    return false;
  }
  return imageCount(realImagesDir) >= 500;
}

/** Load up to `limit` realistic photos (sorted, unique stems) for a batch drop. */
function loadRealPhotos(limit: number): { name: string; buffer: Buffer; type: string }[] {
  const files = fs
    .readdirSync(realImagesDir, { recursive: true })
    .filter((n): n is string => /\.(jpe?g|png|webp)$/i.test(n))
    .sort();
  return files.slice(0, limit).map((relative) => {
    const name = path.basename(relative);
    const ext = path.extname(relative).toLowerCase();
    return { name, buffer: fs.readFileSync(path.join(realImagesDir, relative)), type: MIME[ext] ?? 'image/jpeg' };
  });
}

/** Simulate a drag-and-drop of real files onto the batch drop zone. */
async function dropFiles(
  page: import('@playwright/test').Page,
  files: { name: string; buffer: Buffer; type: string }[],
): Promise<void> {
  const payload = files.map((f) => ({ name: f.name, type: f.type, b64: f.buffer.toString('base64') }));
  const dataTransfer = await page.evaluateHandle((list) => {
    const dt = new DataTransfer();
    for (const f of list) {
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    return dt;
  }, payload);
  await page.dispatchEvent('#drop-zone', 'drop', { dataTransfer });
}

async function downloadZip(page: import('@playwright/test').Page): Promise<string[]> {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-zip-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const zip = await JSZip.loadAsync(Buffer.concat(chunks));
  return Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir)
    .sort();
}

test.describe('PicToWebP browser edition — live batch conversion', () => {
  test('converts multiple dropped files and returns a ZIP of WebP files', async ({ page }) => {
    await page.goto('/');
    await dropFiles(page, [loadFixture('a.png'), loadFixture('b.jpg')]);

    await expect(page.locator('#convert-btn')).toBeEnabled();
    await page.locator('#convert-btn').click();

    await expect(page.locator('#download-zip-btn')).toBeVisible({ timeout: 30_000 });

    const names = await downloadZip(page);
    expect(names).toEqual(['a.webp', 'b.webp']);
  });

  test('reports a corrupt input as a failure and skips it in the ZIP', async ({ page }) => {
    await page.goto('/');
    await dropFiles(page, [loadFixture('a.png'), loadFixture('broken.png')]);

    await expect(page.locator('#convert-btn')).toBeEnabled();
    await page.locator('#convert-btn').click();

    await expect(page.locator('#download-zip-btn')).toBeVisible({ timeout: 30_000 });
    // The UI surfaces the sad path: 1 converted / 2 total, 1 failed.
    await expect(page.locator('#stat-failed')).toContainText('failed');

    // The corrupt file never makes it into the archive.
    const names = await downloadZip(page);
    expect(names).toEqual(['a.webp']);
  });

  test('converts a realistic 40-photo set in the browser', async ({ page }) => {
    test.skip(!ensureRealDataset(), 'run tests/e2e/download_real_dataset.py first');
    const photos = loadRealPhotos(40);

    await page.goto('/');
    await dropFiles(page, photos);

    await expect(page.locator('#convert-btn')).toBeEnabled();
    await page.locator('#convert-btn').click();

    await expect(page.locator('#download-zip-btn')).toBeVisible({ timeout: 120_000 });

    // Surface the throughput the UI itself reports for perf regression checks.
    const elapsed = await page.locator('#complete-time').textContent();
    console.log(`[perf] browser-static batch: ${elapsed} for ${photos.length} photos`);

    const names = await downloadZip(page);
    expect(names).toHaveLength(photos.length);
  });
});