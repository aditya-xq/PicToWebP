import {
  ConversionOptions,
  FileResult,
  computeResize,
  isSupportedImage,
  replaceExtension,
} from './core';

/**
 * Canvas limits: browsers silently fail (or return blank/empty output) beyond
 * these, so oversized inputs are downscaled instead of producing corrupt files.
 * Side cap matches Chromium; area cap matches Chromium's 268MP limit, which is
 * the most generous of the major engines.
 */
const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_AREA = 268_435_456;

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

/** Clamp dimensions to what the canvas implementation can actually encode. */
function clampToCanvasLimits(width: number, height: number): { width: number; height: number } {
  let newWidth = width;
  let newHeight = height;
  if (newWidth > MAX_CANVAS_SIDE || newHeight > MAX_CANVAS_SIDE) {
    const scale = Math.min(MAX_CANVAS_SIDE / newWidth, MAX_CANVAS_SIDE / newHeight);
    newWidth = Math.max(Math.floor(newWidth * scale), 1);
    newHeight = Math.max(Math.floor(newHeight * scale), 1);
  }
  if (newWidth * newHeight > MAX_CANVAS_AREA) {
    const scale = Math.sqrt(MAX_CANVAS_AREA / (newWidth * newHeight));
    newWidth = Math.max(Math.floor(newWidth * scale), 1);
    newHeight = Math.max(Math.floor(newHeight * scale), 1);
  }
  return { width: newWidth, height: newHeight };
}

/** Encode a canvas to WebP via the browser's built-in encoder. */
function canvasToWebp(canvas: HTMLCanvasElement, options: ConversionOptions): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Browser failed to encode WebP'))),
      'image/webp',
      Math.min(Math.max(options.quality, 1), 100) / 100,
    );
  });
}

/** Compute the target size — caps only, never upscales, aspect preserved. */
function fitCanvas(
  img: HTMLImageElement,
  options: ConversionOptions,
): { width: number; height: number } {
  const fitted = computeResize(
    img.naturalWidth,
    img.naturalHeight,
    options.resizeWidth,
    options.resizeHeight,
  );
  return clampToCanvasLimits(fitted.width, fitted.height);
}

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
  try {
    const img = await loadImage(file);
    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
      throw new Error(`${file.name} has no pixel data (corrupt or unsupported format)`);
    }
    const target = fitCanvas(img, options);
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
      return {
        name: replaceExtension(relativePath, '.webp'),
        relativePath,
        originalSize: file.size,
        convertedSize: blob.size,
        success: true,
        blob,
      };
    } finally {
      // Release the backing store promptly — large images hold many MB.
      canvas.width = 0;
      canvas.height = 0;
    }
  } catch (err) {
    return {
      name: relativePath,
      relativePath,
      originalSize: file.size,
      convertedSize: 0,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** True when the browser can encode WebP through the Canvas API. */
export function supportsWebpEncoding(): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  return canvas.toDataURL('image/webp').startsWith('data:image/webp');
}

export interface DirEntry {
  file: File;
  relativePath: string;
}

/**
 * Recursively enumerate supported images under a directory handle.
 * Hidden directories (dot-prefixed) are skipped, matching the CLIs.
 * Individual unreadable entries are skipped with a warning rather than
 * failing the entire scan; `maxDepth` guards against pathological trees.
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
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        results.push({ file, relativePath: entryPath });
      } catch {
        console.warn(`Skipping unreadable file: ${entryPath}`);
      }
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
