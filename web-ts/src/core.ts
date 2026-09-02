/** Pure helpers for the conversion pipeline — no DOM access, unit-testable. */

export interface ConversionOptions {
  quality: number;
}

export interface FileResult {
  /** Output file name (`.webp`). */
  name: string;
  /** Path of the source file relative to the selection root. */
  relativePath: string;
  originalSize: number;
  convertedSize: number;
  success: boolean;
  /** Present when `success` is false. */
  error?: string;
  /** The encoded WebP payload, kept so downloads never re-convert. */
  blob?: Blob;
}

export const SUPPORTED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
]);

export function isSupportedImage(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return SUPPORTED_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/**
 * True when any *directory* segment of the path is dot-prefixed (hidden),
 * matching the CLIs and the handle-based enumeration: hidden directories are
 * skipped, while a hidden file name itself is still convertible.
 */
export function hasHiddenDirectorySegment(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/);
  return segments.slice(0, -1).some((segment) => segment.startsWith('.'));
}

/** Build the success result shared by every conversion backend. */
export function successResult(
  file: File,
  relativePath: string,
  blob: Blob,
): FileResult {
  return {
    name: replaceExtension(relativePath, '.webp'),
    relativePath,
    originalSize: file.size,
    convertedSize: blob.size,
    success: true,
    blob,
  };
}

/** Build the failure result shared by every conversion backend. */
export function failureResult(
  file: File,
  relativePath: string,
  err: unknown,
): FileResult {
  return {
    name: relativePath,
    relativePath,
    originalSize: file.size,
    convertedSize: 0,
    success: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Map every input path to its output path and return the set of inputs that
 * collide with another input (same output path), matching the CLI behaviour:
 * colliding files are reported as failures instead of silently overwriting.
 */
export function findCollisions(relativePaths: string[]): Set<string> {
  const destinations = new Map<string, string[]>();
  for (const path of relativePaths) {
    const destination = replaceExtension(path, '.webp');
    const existing = destinations.get(destination);
    if (existing) existing.push(path);
    else destinations.set(destination, [path]);
  }

  const collided = new Set<string>();
  for (const inputs of destinations.values()) {
    if (inputs.length > 1) inputs.forEach((path) => collided.add(path));
  }
  return collided;
}

export function replaceExtension(path: string, extension: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot < slash) return path + extension;
  return path.slice(0, dot) + extension;
}

/**
 * Canvas limits: browsers silently fail (or return blank/empty output) beyond
 * these, so oversized inputs are downscaled instead of producing corrupt files.
 * Side cap matches Chromium; area cap matches Chromium's 268MP limit, which is
 * the most generous of the major engines.
 */
export const MAX_CANVAS_SIDE = 16384;
export const MAX_CANVAS_AREA = 268_435_456;

/** Clamp dimensions to what the canvas implementation can actually encode. */
export function clampToCanvasLimits(width: number, height: number): { width: number; height: number } {
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

/** Normalise a 1-100 quality value to the 0-1 range the canvas API expects. */
export function webpQuality(quality: number): number {
  return Math.min(Math.max(quality, 1), 100) / 100;
}

/**
 * Rough heuristic for how much a batch will shrink, used only for the pre-run
 * "≈ X output" estimate in the source badge — never for anything authoritative.
 * Higher quality keeps more data; the ratios are tuned to typical photo mixes.
 */
export function estimateWebpBytes(originalBytes: number, quality: number): number {
  if (originalBytes <= 0) return 0;
  const ratio = quality >= 90 ? 0.45 : quality >= 75 ? 0.38 : quality >= 60 ? 0.32 : 0.26;
  return originalBytes * ratio;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

export function estimateEtaSeconds(elapsed: number, fraction: number): number | null {
  if (fraction <= 0 || fraction >= 1 || elapsed <= 0) return null;
  return (elapsed * (1 - fraction)) / fraction;
}
