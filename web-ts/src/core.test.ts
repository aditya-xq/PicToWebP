import { describe, expect, it } from 'vitest';
import {
  MAX_CANVAS_AREA,
  MAX_CANVAS_SIDE,
  clampToCanvasLimits,
  cliOutputFolderName,
  estimateEtaSeconds,
  estimateWebpBytes,
  findCollisions,
  formatBytes,
  formatDuration,
  hasHiddenDirectorySegment,
  isSupportedImage,
  replaceExtension,
  webpQuality,
} from './core';

describe('isSupportedImage', () => {
  it('accepts supported extensions case-insensitively', () => {
    expect(isSupportedImage('photo.png')).toBe(true);
    expect(isSupportedImage('photo.PNG')).toBe(true);
    expect(isSupportedImage('photo.Jpg')).toBe(true);
    expect(isSupportedImage('a/b/c.tif')).toBe(true);
  });

  it('rejects unsupported or extension-less names', () => {
    expect(isSupportedImage('notes.txt')).toBe(false);
    expect(isSupportedImage('noext')).toBe(false);
    expect(isSupportedImage('')).toBe(false);
  });
});

describe('hasHiddenDirectorySegment', () => {
  it('detects dot-prefixed directories anywhere in the path', () => {
    expect(hasHiddenDirectorySegment('.git/config.png')).toBe(true);
    expect(hasHiddenDirectorySegment('photos/.hidden/pic.jpg')).toBe(true);
    expect(hasHiddenDirectorySegment('photos/.hidden/deep/pic.jpg')).toBe(true);
    expect(hasHiddenDirectorySegment('a/.b/c.png')).toBe(true);
  });

  it('accepts plain paths and hidden file names (files are convertible)', () => {
    expect(hasHiddenDirectorySegment('photo.png')).toBe(false);
    expect(hasHiddenDirectorySegment('nested/photo.png')).toBe(false);
    expect(hasHiddenDirectorySegment('.profile.png')).toBe(false);
    expect(hasHiddenDirectorySegment('')).toBe(false);
  });
});

describe('findCollisions', () => {
  it('flags same-stem inputs that map to one output', () => {
    const collisions = findCollisions(['nested/photo.png', 'nested/photo.jpg', 'unique.webp']);
    expect(collisions).toEqual(new Set(['nested/photo.png', 'nested/photo.jpg']));
  });

  it('returns nothing for unique paths', () => {
    expect(findCollisions(['a.png', 'b.jpg'])).toEqual(new Set());
  });

  it('handles files without an extension', () => {
    expect(findCollisions(['a', 'b'])).toEqual(new Set());
    expect(findCollisions(['a', 'a'])).toEqual(new Set(['a', 'a']));
  });
});

describe('replaceExtension', () => {
  it('replaces the last extension only', () => {
    expect(replaceExtension('a.b.c.png', '.webp')).toBe('a.b.c.webp');
    expect(replaceExtension('nested/dir/photo.JPG', '.webp')).toBe('nested/dir/photo.webp');
  });

  it('appends when there is no extension', () => {
    expect(replaceExtension('photo', '.webp')).toBe('photo.webp');
    expect(replaceExtension('some.dir/photo', '.webp')).toBe('some.dir/photo.webp');
  });
});

describe('formatBytes', () => {
  it('uses readable units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB');
  });
});

describe('formatDuration', () => {
  it('stays compact', () => {
    expect(formatDuration(7.24)).toBe('7.2s');
    expect(formatDuration(46.11)).toBe('46.1s');
    expect(formatDuration(65)).toBe('1m 05s');
    expect(formatDuration(186)).toBe('3m 06s');
  });
});

describe('estimateEtaSeconds', () => {
  it('extrapolates from progress', () => {
    expect(estimateEtaSeconds(10, 0.5)).toBeCloseTo(10);
    expect(estimateEtaSeconds(30, 0.25)).toBeCloseTo(90);
  });

  it('returns null outside (0, 1)', () => {
    expect(estimateEtaSeconds(10, 0)).toBeNull();
    expect(estimateEtaSeconds(10, 1)).toBeNull();
    expect(estimateEtaSeconds(0, 0.5)).toBeNull();
  });
});

describe('clampToCanvasLimits', () => {
  it('passes normal sizes through untouched', () => {
    expect(clampToCanvasLimits(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(clampToCanvasLimits(MAX_CANVAS_SIDE, MAX_CANVAS_SIDE)).toEqual({
      width: MAX_CANVAS_SIDE,
      height: MAX_CANVAS_SIDE,
    });
  });

  it('clamps oversized sides while preserving aspect ratio', () => {
    const r = clampToCanvasLimits(32768, 16384);
    expect(r.width).toBe(MAX_CANVAS_SIDE);
    expect(r.height).toBe(MAX_CANVAS_SIDE / 2);
    expect(r.height).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
  });

  it('clamps oversized total area (huge square-ish images)', () => {
    const r = clampToCanvasLimits(20000, 20000); // 400MP > 268MP cap
    expect(r.width).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    expect(r.height).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    expect(r.width * r.height).toBeLessThanOrEqual(MAX_CANVAS_AREA);
  });

it('never returns zero or negative dimensions', () => {
    const r = clampToCanvasLimits(MAX_CANVAS_SIDE + 1, 1);
    expect(r.width).toBeGreaterThanOrEqual(1);
    expect(r.height).toBeGreaterThanOrEqual(1);
  });
});

describe('webpQuality', () => {
  it('normalises the 1-100 slider value to the 0-1 range', () => {
    expect(webpQuality(80)).toBe(0.8);
    expect(webpQuality(100)).toBe(1);
    expect(webpQuality(0)).toBe(0.01);
    expect(webpQuality(150)).toBe(1);
  });
});

describe('estimateWebpBytes', () => {
  it('returns 0 for empty sources', () => {
    expect(estimateWebpBytes(0, 80)).toBe(0);
  });

  it('estimates smaller output at lower quality', () => {
    const low = estimateWebpBytes(1_000_000, 60);
    const high = estimateWebpBytes(1_000_000, 95);
    expect(low).toBeLessThan(high);
    expect(high).toBeLessThan(1_000_000);
  });

  it('estimates within a sane band for typical quality', () => {
    const est = estimateWebpBytes(100_000_000, 80);
    expect(est).toBeGreaterThan(0);
    expect(est).toBeLessThan(100_000_000);
  });
});

describe('cliOutputFolderName', () => {
  const date = new Date(2026, 8, 2, 14, 5, 9, 123);

  it('follows the CLI <source>_webp_<timestamp> contract', () => {
    expect(cliOutputFolderName('vacation', date)).toBe('vacation_webp_20260902_140509_123000');
  });

  it('sanitizes characters that are unsafe in folder or zip names', () => {
    expect(cliOutputFolderName('Dropped files', date)).toBe('Dropped_files_webp_20260902_140509_123000');
    expect(cliOutputFolderName('a/b\\c:d*e?f"g<h>i|j', date)).toBe(
      'a_b_c_d_e_f_g_h_i_j_webp_20260902_140509_123000',
    );
  });

  it('falls back to a default stem for empty or punctuated labels', () => {
    expect(cliOutputFolderName('', date)).toBe('images_webp_20260902_140509_123000');
    expect(cliOutputFolderName('///', date)).toBe('images_webp_20260902_140509_123000');
  });
});
