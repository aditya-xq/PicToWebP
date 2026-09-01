import {
  ConversionOptions,
  FileResult,
  failureResult,
  isSupportedImage,
  successResult,
  targetDimensions,
  webpQuality,
} from './core';

/**
 * Conversion backend: a pool of OffscreenCanvas workers when the browser
 * supports them, with a transparent main-thread fallback otherwise. Callers
 * only ever see `convertFile` / `convertEntry`.
 */

/* --------------------------- Worker pool ----------------------------- */

const POOL_SIZE = Math.min(6, Math.max(2, navigator.hardwareConcurrency || 4));
/** Watchdog: a job that never answers means a wedged worker — fail over. */
const JOB_TIMEOUT_MS = 120_000;
/**
 * Idle workers each pin a JS isolate (several MB), so the pool is torn down
 * after a quiet period and transparently re-created on the next conversion.
 */
const WORKER_IDLE_SHUTDOWN_MS = 30_000;

interface PendingRequest {
  resolve: (result: FileResult) => void;
  reject: (err: Error) => void;
}

let workers: Worker[] | null = null;
let workerBroken = false;
const pending = new Map<number, PendingRequest>();
let nextJobId = 1;
let nextWorker = 0;
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;

function workerSupported(): boolean {
  return (
    !workerBroken &&
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap === 'function'
  );
}

function initWorkers(): Worker[] {
  if (workers) return workers;
  workers = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<{ id: number; result: FileResult }>) => {
      const { id, result } = event.data;
      const job = pending.get(id);
      if (job) {
        pending.delete(id);
        job.resolve(result);
      }
    });
    worker.addEventListener('error', () => {
      // A crashed worker fails everything it owes; future conversions fall
      // back to the main thread.
      for (const [id, job] of pending) {
        pending.delete(id);
        job.reject(new Error('Conversion worker crashed'));
      }
      workerBroken = true;
      terminateWorkers();
    });
    workers.push(worker);
  }
  return workers;
}

function terminateWorkers(): void {
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
  for (const worker of workers ?? []) worker.terminate();
  workers = null;
}

function scheduleIdleShutdown(): void {
  if (idleShutdownTimer) clearTimeout(idleShutdownTimer);
  idleShutdownTimer = setTimeout(() => {
    idleShutdownTimer = null;
    // A job dispatched since scheduling cleared the timer; this only fires
    // when the pool has been truly idle for the whole window.
    if (pending.size === 0) terminateWorkers();
  }, WORKER_IDLE_SHUTDOWN_MS);
}

function convertInWorker(
  file: File,
  options: ConversionOptions,
  relativePath: string,
): Promise<FileResult> {
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
  const pool = initWorkers();
  const worker = pool[nextWorker++ % pool.length];
  const id = nextJobId++;
  return new Promise<FileResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Conversion worker timed out'));
    }, JOB_TIMEOUT_MS);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timeout);
        scheduleIdleShutdown();
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timeout);
        scheduleIdleShutdown();
        reject(err);
      },
    });
    worker.postMessage({ id, file, options, relativePath });
  });
}

/* ----------------------- Main-thread fallback ------------------------ */

/** Decode an image file into a fully-decoded HTMLImageElement. */
async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Failed to load ${file.name}`));
      img.src = url;
    });
    // Ensure pixels are actually rasterized before drawing.
    if (typeof img.decode === 'function') {
      try {
        await img.decode();
      } catch {
        /* decode() can reject on some exotic formats that still draw fine */
      }
    }
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Encode a canvas to WebP via the browser's built-in encoder. */
function canvasToWebp(canvas: HTMLCanvasElement, options: ConversionOptions): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Browser failed to encode WebP'))),
      'image/webp',
      webpQuality(options.quality),
    );
  });
}

async function convertOnMainThread(
  file: File,
  options: ConversionOptions,
  relativePath: string,
): Promise<FileResult> {
  try {
    const img = await loadImage(file);
    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
      throw new Error(`${file.name} has no pixel data (corrupt or unsupported format)`);
    }
    const target = targetDimensions(img.naturalWidth, img.naturalHeight, options);
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    try {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, target.width, target.height);

      const blob = await canvasToWebp(canvas, options);
      return successResult(file, relativePath, blob);
    } finally {
      // Release the backing store promptly — large images hold many MB.
      canvas.width = 0;
      canvas.height = 0;
    }
  } catch (err) {
    return failureResult(file, relativePath, err);
  }
}

/* ---------------------------- Public API ----------------------------- */

/**
 * Convert one image file to WebP. The encoded blob is returned in the result
 * so downloads never need to re-convert. Canvas decoding always strips
 * EXIF/GPS metadata — there is no way to preserve it in the browser.
 *
 * `relativePath` identifies the source inside the selection (defaults to the
 * bare file name) and flows through to the result so output paths are exact
 * even when subdirectories contain same-named files.
 */
export async function convertFile(
  file: File,
  options: ConversionOptions,
  relativePath: string = file.name,
): Promise<FileResult> {
  if (workerSupported()) {
    try {
      return await convertInWorker(file, options, relativePath);
    } catch {
      // Worker pool failure (e.g. crash): retry once on the main thread.
    }
  }
  return convertOnMainThread(file, options, relativePath);
}

/** True when the browser can encode WebP through the Canvas API. */
export function supportsWebpEncoding(): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  return canvas.toDataURL('image/webp').startsWith('data:image/webp');
}

/**
 * A selected source: either an in-memory `File` (dropped/pasted/single
 * selection) or a file `handle` from a picked directory, whose `File` is
 * resolved lazily at conversion time so scanning huge trees stays cheap.
 */
export interface DirEntry {
  relativePath: string;
  file?: File;
  handle?: FileSystemFileHandle;
}

/** Resolve the concrete `File` behind an entry (lazily for handles). */
export async function resolveEntryFile(entry: DirEntry): Promise<File> {
  if (entry.file) return entry.file;
  if (entry.handle) return entry.handle.getFile();
  throw new Error(`No source for ${entry.relativePath}`);
}

/**
 * Recursively enumerate supported images under a directory handle.
 * Hidden directories (dot-prefixed) are skipped, matching the CLIs.
 * File contents are NOT read here — entries keep their handles and the
 * `File` objects are resolved during conversion. Individual unreadable
 * entries are skipped with a warning; `maxDepth` guards pathological trees.
 */
export async function enumerateFiles(
  dirHandle: FileSystemDirectoryHandle,
  basePath: string = '',
  maxDepth: number = 32,
): Promise<DirEntry[]> {
  const results: DirEntry[] = [];

  for await (const entry of dirHandle.values()) {
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      if (!isSupportedImage(entry.name)) continue;
      results.push({ handle: entry as FileSystemFileHandle, relativePath: entryPath });
    } else if (entry.kind === 'directory' && !entry.name.startsWith('.')) {
      if (maxDepth <= 0) {
        console.warn(`Skipping deeply nested directory: ${entryPath}`);
        continue;
      }
      try {
        const subFiles = await enumerateFiles(
          entry as FileSystemDirectoryHandle,
          entryPath,
          maxDepth - 1,
        );
        results.push(...subFiles);
      } catch {
        console.warn(`Skipping unreadable directory: ${entryPath}`);
      }
    }
  }
  return results;
}

/** Write a blob to `relativePath` inside a directory, creating subfolders. */
export async function writeFileToDir(
  dirHandle: FileSystemDirectoryHandle,
  relativePath: string,
  blob: Blob,
): Promise<void> {
  const parts = relativePath.split('/');
  let current = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    current = await current.getDirectoryHandle(parts[i], { create: true });
  }
  const fileHandle = await current.getFileHandle(parts[parts.length - 1], {
    create: true,
  });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (err) {
    // Never leave a half-written file or an unclosed stream behind.
    await writable.abort().catch(() => {});
    throw err;
  }
}

export type { ConversionOptions, FileResult };
