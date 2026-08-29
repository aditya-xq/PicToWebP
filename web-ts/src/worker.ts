/**
 * Conversion worker: decodes and re-encodes images on an OffscreenCanvas so
 * the UI thread stays responsive during bulk conversions.
 *
 * Protocol: receive `{ id, file, options, relativePath }`, respond with
 * `{ id, result: FileResult }` (always — failures are results, not exceptions,
 * so the pool never leaks pending promises).
 */
import {
  ConversionOptions,
  FileResult,
  clampToCanvasLimits,
  computeResize,
  replaceExtension,
} from './core';

interface ConvertRequest {
  id: number;
  file: File;
  options: ConversionOptions;
  relativePath: string;
}

async function convert(request: ConvertRequest): Promise<FileResult> {
  const { file, options, relativePath } = request;
  try {
    // createImageBitmap decodes straight from the File — no object URL,
    // no HTMLImageElement, and EXIF/GPS never survives the re-encode.
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width === 0 || bitmap.height === 0) {
        throw new Error(`${file.name} has no pixel data (corrupt or unsupported format)`);
      }
      const fitted = computeResize(
        bitmap.width,
        bitmap.height,
        options.resizeWidth,
        options.resizeHeight,
      );
      const target = clampToCanvasLimits(fitted.width, fitted.height);
      const canvas = new OffscreenCanvas(target.width, target.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, target.width, target.height);

      const blob = await canvas.convertToBlob({
        type: 'image/webp',
        quality: Math.min(Math.max(options.quality, 1), 100) / 100,
      });
      return {
        name: replaceExtension(relativePath, '.webp'),
        relativePath,
        originalSize: file.size,
        convertedSize: blob.size,
        success: true,
        blob,
      };
    } finally {
      bitmap.close();
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

self.addEventListener('message', (event: MessageEvent<ConvertRequest>) => {
  const request = event.data;
  convert(request)
    .then((result) => (self as unknown as Worker).postMessage({ id: request.id, result }))
    .catch((err) =>
      (self as unknown as Worker).postMessage({
        id: request.id,
        result: {
          name: request.relativePath,
          relativePath: request.relativePath,
          originalSize: request.file.size,
          convertedSize: 0,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies FileResult,
      }),
    );
});
