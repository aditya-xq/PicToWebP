/**
 * Browser backend: everything happens in the tab. Used by the static build
 * (GitHub Pages). Wraps the OffscreenCanvas worker pool, the File System
 * Access API, JSZip and localStorage behind the ConversionBackend contract.
 */
import JSZip from 'jszip';
import { FileResult, findCollisions, formatBytes, formatDuration } from '../core';
import {
  convertFile,
  enumerateFiles,
  resolveEntryFile,
  supportsWebpEncoding,
  writeFileToDir,
} from '../converter';
import { triggerDownload } from '../ui/dom';
import type {
  BackendCapabilities,
  ConversionBackend,
  ConversionOptions,
  ConversionResult,
  HistoryEntry,
  ProgressSnapshot,
  SourceSelection,
  SourceSummary,
} from './types';

const CONCURRENCY = 4;
const HISTORY_KEY = 'pictowebp-history';
const HISTORY_LIMIT = 50;

function readHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export class BrowserBackend implements ConversionBackend {
  readonly kind = 'browser' as const;
  readonly capabilities: BackendCapabilities = {
    kind: 'browser',
    folderPick: 'fs-access',
    lossless: false,
    metadataControl: false,
    saveToFolder: true,
    openOutputFolder: false,
    historyStore: 'local',
    serverValidate: false,
  };

  private cancelRequested = false;

  async probe(): Promise<boolean> {
    return supportsWebpEncoding();
  }

  async pickFolder(): Promise<SourceSelection | null> {
    if (!('showDirectoryPicker' in window)) return null;
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      return { label: handle.name, entries: [], dirHandle: handle };
    } catch {
      return null; // AbortError (user closed the picker)
    }
  }

  async browse(): Promise<never> {
    throw new Error('Folder browsing is only available with the Python backend');
  }

  async enumerate(selection: SourceSelection): Promise<SourceSummary> {
    const handle = selection.dirHandle;
    if (handle) {
      const entries = await enumerateFiles(handle);
      selection.entries = entries;
      selection.label = handle.name;
      const collided = findCollisions(entries.map((e) => e.relativePath)).size;
      const detail = entries.length
        ? `${entries.length} image${entries.length === 1 ? '' : 's'}` +
          (collided > 0 ? ` · ${collided} skipped (name conflicts)` : '')
        : 'No supported images found';
      return {
        valid: entries.length > 0,
        label: selection.label,
        totalFiles: entries.length,
        totalBytes: 0,
        collided,
        detail,
      };
    }
    const entries = selection.entries ?? [];
    const collided = findCollisions(entries.map((e) => e.relativePath)).size;
    const totalBytes = entries.every((e) => e.file)
      ? entries.reduce((sum, e) => sum + (e.file?.size ?? 0), 0)
      : 0;
    const detail =
      `${entries.length} image${entries.length === 1 ? '' : 's'}` +
      (entries.length > 0 && entries.every((e) => e.file) ? ` · ${formatBytes(totalBytes)}` : '') +
      (collided > 0 ? ` · ${collided} skipped (name conflicts)` : '');
    return {
      valid: entries.length > 0,
      label: selection.label,
      totalFiles: entries.length,
      totalBytes,
      collided,
      detail,
    };
  }

  async convert(
    selection: SourceSelection,
    options: ConversionOptions,
    onProgress: (p: ProgressSnapshot) => void,
  ): Promise<ConversionResult> {
    const entries = selection.entries ?? [];
    const collided = findCollisions(entries.map((e) => e.relativePath));
    const queue = entries.filter((e) => !collided.has(e.relativePath));
    const total = entries.length;
    const results: FileResult[] = [];
    const started = performance.now();
    this.cancelRequested = false;

    const coreOptions = {
      quality: options.quality,
      resizeWidth: options.resizeWidth,
      resizeHeight: options.resizeHeight,
    };

    const emit = (): void => {
      const processed = results.length;
      const fraction = total > 0 ? processed / total : 0;
      const elapsed = (performance.now() - started) / 1000;
      onProgress({
        status: 'running',
        processed,
        total,
        elapsedSeconds: elapsed,
        fraction,
        etaSeconds: fraction > 0 && fraction < 1 ? (elapsed * (1 - fraction)) / fraction : null,
      });
    };

    emit();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < queue.length && !this.cancelRequested) {
        const entry = queue[next++];
        try {
          const file = await resolveEntryFile(entry);
          results.push(await convertFile(file, coreOptions, entry.relativePath));
        } catch (err) {
          results.push({
            name: entry.relativePath,
            relativePath: entry.relativePath,
            originalSize: entry.file?.size ?? 0,
            convertedSize: 0,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        emit();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    emit();

    const successful = results.filter((r) => r.success);
    const originalBytes = successful.reduce((sum, r) => sum + r.originalSize, 0);
    const convertedBytes = successful.reduce((sum, r) => sum + r.convertedSize, 0);
    const bytesSaved = Math.max(0, originalBytes - convertedBytes);
    const failures = [
      ...results.filter((r) => !r.success).map((r) => ({ name: r.name, reason: r.error ?? 'Conversion failed' })),
      ...[...collided].map((p) => ({ name: p, reason: 'Output name collision' })),
    ];

    const result: ConversionResult = {
      ok: successful.length > 0,
      cancelled: this.cancelRequested,
      blobs: successful.filter((r) => r.blob),
      failures,
      stats: {
        totalFiles: total,
        convertedFiles: successful.length,
        failedFiles: total - successful.length,
        originalBytes,
        convertedBytes,
        bytesSaved,
        reductionPercent: originalBytes > 0 ? (bytesSaved / originalBytes) * 100 : 0,
        elapsedSeconds: (performance.now() - started) / 1000,
        outputFolder: null,
      },
    };

    if (result.ok) this.recordHistory(selection.label, options.quality, result);
    return result;
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
  }

  async saveToFolder(result: ConversionResult): Promise<{ written: number; failed: string[] }> {
    const blobs = result.blobs;
    if (blobs.length === 0) return { written: 0, failed: [] };
    const outputHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    let written = 0;
    const failed: string[] = [];
    for (const entry of blobs) {
      if (!entry.blob) continue;
      try {
        // `entry.name` is the converted path (`.webp`, folder structure kept);
        // `relativePath` is the original input path and must not be reused.
        await writeFileToDir(outputHandle, entry.name, entry.blob);
        written++;
      } catch {
        failed.push(entry.name);
      }
    }
    return { written, failed };
  }

  async downloadZip(result: ConversionResult): Promise<void> {
    const blobs = result.blobs.filter((r) => r.blob);
    if (blobs.length === 0) throw new Error('Nothing to download');
    const zip = new JSZip();
    for (const entry of blobs) zip.file(entry.name, entry.blob!);
    const blob = await zip.generateAsync({ type: 'blob' });
    triggerDownload(blob, 'converted-images.zip');
  }

  async openOutputFolder(): Promise<void> {
    throw new Error('Not supported');
  }

  async convertSingle(file: File, options: ConversionOptions): Promise<FileResult> {
    return convertFile(file, {
      quality: options.quality,
      resizeWidth: options.resizeWidth,
      resizeHeight: options.resizeHeight,
    });
  }

  async getHistory(): Promise<HistoryEntry[]> {
    return readHistory();
  }

  async clearHistory(): Promise<void> {
    localStorage.removeItem(HISTORY_KEY);
  }

  private recordHistory(label: string, quality: number, result: ConversionResult): void {
    const all = readHistory();
    all.unshift({
      id: Math.random().toString(36).slice(2, 10),
      name: label,
      files: `${result.stats.convertedFiles}/${result.stats.totalFiles}`,
      saved: formatBytes(result.stats.bytesSaved),
      percent: `${result.stats.reductionPercent.toFixed(1)}%`,
      elapsed: formatDuration(result.stats.elapsedSeconds),
      timestamp: Date.now(),
    });
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(all.slice(0, HISTORY_LIMIT)));
    } catch {
      // Storage may be unavailable (private mode / quota) — history is optional.
    }
  }
}