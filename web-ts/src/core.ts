/** Pure helpers for the conversion pipeline — no DOM access, unit-testable. */

export interface ConversionOptions {
  quality: number;
  resizeWidth: number | null;
  resizeHeight: number | null;
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

export function imageExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
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

/** Clamp-based resize that never upscales and preserves the aspect ratio. */
export function computeResize(
  width: number,
  height: number,
  maxWidth: number | null,
  maxHeight: number | null,
): { width: number; height: number } {
  let newWidth = width;
  let newHeight = height;

  if (maxWidth !== null && maxWidth > 0 && newWidth > maxWidth) {
    newHeight = Math.max(Math.floor((newHeight * maxWidth) / newWidth), 1);
    newWidth = maxWidth;
  }
  if (maxHeight !== null && maxHeight > 0 && newHeight > maxHeight) {
    newWidth = Math.max(Math.floor((newWidth * maxHeight) / newHeight), 1);
    newHeight = maxHeight;
  }
  return { width: newWidth, height: newHeight };
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
