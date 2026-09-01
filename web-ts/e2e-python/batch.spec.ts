import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const here = path.dirname(fileURLToPath(import.meta.url));
// The SAME fixture corpus every tool's E2E uses (tests/e2e/fixtures), so the
// Python server edition is verified against identical data to the CLIs.
const fixtures = path.resolve(here, '..', '..', 'tests', 'e2e', 'fixtures');
const realImagesDir = path.resolve(here, '..', '..', 'tests', 'e2e', 'real_images');

const EXPECTED_WEBP = [
  'a.webp',
  'b.webp',
  'c.webp',
  'd.webp',
  'e.webp',
  'f.webp',
  'nested/deep/leaf.webp',
];

/**
 * Click the browse-modal entry whose folder name matches exactly, waiting for
 * the async re-listing to land (the modal navigates via server round-trips).
 */
async function clickBrowseEntry(page: import('@playwright/test').Page, name: string): Promise<void> {
  const item = page.locator('#browse-list').getByRole('button', { name, exact: true });
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();
  // The current path must advance to the clicked target before the next step.
  await expect(page.locator('#browse-current')).toContainText(name, { timeout: 10_000 });
}

/** Open the server file browser and drive it to `corpus`, then select it. */
async function selectFolderViaBrowse(page: import('@playwright/test').Page, corpus: string): Promise<void> {
  await page.locator('#drop-zone').click();
  await expect(page.locator('#browse-list .browse-item').first()).toBeVisible();

  const rootSeg = path.parse(os.tmpdir()).root; // e.g. "C:\\"
  if (process.platform === 'win32') {
    await clickBrowseEntry(page, rootSeg); // drives render as "C:\"
  }
  const rel = path.relative(rootSeg, corpus);
  for (const segment of rel.split(path.sep)) {
    await clickBrowseEntry(page, segment);
  }
  await page.locator('#browse-select-btn').click();
}

async function downloadZip(
  page: import('@playwright/test').Page,
): Promise<{ names: string[]; zip: JSZip }> {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-zip-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const zip = await JSZip.loadAsync(Buffer.concat(chunks));
  return {
    names: Object.keys(zip.files)
      .filter((name) => !zip.files[name].dir)
      .sort(),
    zip,
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

/** Copy up to `limit` realistic photos (unique basenames) into `dest`. */
function copyRealPhotos(dest: string, limit: number): number {
  const files = fs
    .readdirSync(realImagesDir, { recursive: true })
    .filter((n): n is string => /\.(jpe?g|png|webp)$/i.test(n))
    .sort();
  for (const relative of files.slice(0, limit)) {
    fs.copyFileSync(path.join(realImagesDir, relative), path.join(dest, path.basename(relative)));
  }
  return files.slice(0, limit).length;
}

test.describe('PicToWebP server edition — live batch conversion', () => {
  test('converts a real folder end-to-end and returns a ZIP of WebP files', async ({ page }) => {
    // Fresh corpus in the OS temp dir; removed in `finally`.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-batch-'));
    const corpus = path.join(root, 'photos');
    fs.cpSync(fixtures, corpus, { recursive: true });

    try {
      await page.goto('/');

      // Open the server file browser and navigate drive-by-drive to the corpus.
      await selectFolderViaBrowse(page, corpus);

      // Select the folder, then start a real batch conversion.
      await expect(page.locator('#convert-btn')).toBeEnabled();
      await page.locator('#convert-btn').click();

      // Conversion runs server-side (POST /convert + SSE /progress); the
      // results panel only renders once the batch actually completes.
      await expect(page.locator('#download-zip-btn')).toBeVisible({ timeout: 60_000 });

      // The UI surfaces the sad paths: corrupt input + dup.* collision are
      // reported in the results summary (7/10 converted, 3 failed).
      await expect(page.locator('#stat-failed')).toContainText('failed');

      // Download the ZIP produced from the on-disk output folder.
      const { names, zip } = await downloadZip(page);

      // Python engine converts all six formats plus the nested leaf.
      const webpNames = names.filter((name) => name.endsWith('.webp'));
      expect(webpNames).toEqual(EXPECTED_WEBP);
      // The server zips the whole output folder, so the error report for the
      // sad-path inputs travels inside the archive.
      expect(names).toContain('conversion-errors.txt');
      // Sad paths never leak into the archive: corrupt input, hidden
      // directory and the ambiguous dup.* collision produce no output.
      expect(webpNames.some((name) => name.includes('broken'))).toBe(false);
      expect(webpNames.some((name) => name.includes('.hidden'))).toBe(false);
      expect(webpNames.filter((name) => name === 'dup.webp')).toHaveLength(0);

      // Spot-check that an entry is a real WebP container (RIFF....WEBP).
      const sample = await zip.file('a.webp')!.async('nodebuffer');
      expect(sample.subarray(0, 4).toString('ascii')).toBe('RIFF');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('converts a realistic 40-photo set through the server', async ({ page }) => {
    test.skip(!ensureRealDataset(), 'run tests/e2e/download_real_dataset.py first');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-batch-real-'));
    const corpus = path.join(root, 'photos');
    fs.mkdirSync(corpus);
    const count = copyRealPhotos(corpus, 40);

    try {
      await page.goto('/');
      await selectFolderViaBrowse(page, corpus);

      await expect(page.locator('#convert-btn')).toBeEnabled();
      await page.locator('#convert-btn').click();

      await expect(page.locator('#download-zip-btn')).toBeVisible({ timeout: 120_000 });

      const elapsed = await page.locator('#complete-time').textContent();
      console.log(`[perf] python-server batch: ${elapsed} for ${count} photos`);

      const { names } = await downloadZip(page);
      const webpNames = names.filter((name) => name.endsWith('.webp'));
      expect(webpNames).toHaveLength(count);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});