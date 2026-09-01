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
  failureResult,
  successResult,
  targetDimensions,
  webpQuality,
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
      const target = targetDimensions(bitmap.width, bitmap.height, options);
      const canvas = new OffscreenCanvas(target.width, target.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, target.width, target.height);

      const blob = await canvas.convertToBlob({
        type: 'image/webp',
        quality: webpQuality(options.quality),
      });
      return successResult(file, relativePath, blob);
    } finally {
      bitmap.close();
    }
  } catch (err) {
    return failureResult(file, relativePath, err);
  }
}

self.addEventListener('message', (event: MessageEvent<ConvertRequest>) => {
  const request = event.data;
  convert(request)
    .then((result) => (self as unknown as Worker).postMessage({ id: request.id, result }))
    .catch((err) =>
      (self as unknown as Worker).postMessage({
        id: request.id,
        result: failureResult(request.file, request.relativePath, err),
      }),
    );
});
