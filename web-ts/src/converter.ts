import {
  ConversionOptions,
  FileResult,
  computeResize,
  isSupportedImage,
  replaceExtension,
} from './core';

/** Decode an image file into an HTMLImageElement, cleaning up the object URL. */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to load ${file.name}`));
    };
    img.src = url;
  });
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
  return computeResize(
    img.naturalWidth,
    img.naturalHeight,
    options.resizeWidth,
    options.resizeHeight,
  );
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
    const target = fitCanvas(img, options);
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
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
 */
export async function enumerateFiles(
  dirHandle: FileSystemDirectoryHandle,
  basePath: string = '',
): Promise<DirEntry[]> {
  const results: DirEntry[] = [];

  for await (const entry of dirHandle.values()) {
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      if (!isSupportedImage(entry.name)) continue;
      const file = await (entry as FileSystemFileHandle).getFile();
      results.push({ file, relativePath: entryPath });
    } else if (entry.kind === 'directory' && !entry.name.startsWith('.')) {
      const subFiles = await enumerateFiles(entry as FileSystemDirectoryHandle, entryPath);
      results.push(...subFiles);
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
  await writable.write(blob);
  await writable.close();
}

export type { ConversionOptions, FileResult };
