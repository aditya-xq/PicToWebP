import { describe, expect, it } from 'vitest';
import {
  computeResize,
  estimateEtaSeconds,
  findCollisions,
  formatBytes,
  formatDuration,
  isSupportedImage,
  replaceExtension,
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

describe('computeResize', () => {
  it('never upscales', () => {
    expect(computeResize(16, 16, 256, 256)).toEqual({ width: 16, height: 16 });
  });

  it('caps by width preserving aspect ratio', () => {
    expect(computeResize(640, 480, 320, null)).toEqual({ width: 320, height: 240 });
  });

  it('caps by height preserving aspect ratio', () => {
    expect(computeResize(640, 480, null, 240)).toEqual({ width: 320, height: 240 });
  });

  it('applies width then height caps', () => {
    expect(computeResize(1000, 500, 320, 100)).toEqual({ width: 200, height: 100 });
  });

  it('leaves images within bounds untouched', () => {
    expect(computeResize(300, 200, 320, 240)).toEqual({ width: 300, height: 200 });
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
