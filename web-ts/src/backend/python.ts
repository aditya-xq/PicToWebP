/**
 * Python backend: a thin HTTP client over the local FastAPI server
 * (pictowebp-web). Used by the `build:python` profile. The server owns the
 * conversion (Pillow + ProcessPool), the SSE progress stream, ZIP output,
 * folder browsing and "open folder".
 */
import { FileResult, replaceExtension } from '../core';
import { triggerDownload } from '../ui/dom';
import type {
  BackendCapabilities,
  BrowseResult,
  ConversionBackend,
  ConversionOptions,
  ConversionResult,
  ProgressSnapshot,
  SourceSelection,
  SourceSummary,
} from './types';
import { TERMINAL_STATUSES } from './types';

/** Raw snapshot shape emitted by the server's /progress and /api/status. */
interface PythonSnapshot {
  status: string;
  error?: string | null;
  total_files: number;
  processed_files: number;
  converted_files: number;
  failed_files: number;
  original_bytes: number;
  converted_bytes: number;
  bytes_saved: number;
  reduction_percent: number;
  fraction_complete: number;
  elapsed_seconds: number;
  output_folder?: string | null;
  current_file?: string | null;
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function mapProgress(d: PythonSnapshot): ProgressSnapshot {
  const fraction = d.fraction_complete;
  return {
    status: (d.status as ProgressSnapshot['status']) ?? 'running',
    processed: d.processed_files,
    total: d.total_files,
    elapsedSeconds: d.elapsed_seconds,
    fraction,
    etaSeconds: fraction > 0 && fraction < 1 ? (d.elapsed_seconds * (1 - fraction)) / fraction : null,
    error: d.error ?? undefined,
    currentFile: d.current_file ?? undefined,
  };
}

function fromSnapshot(d: PythonSnapshot): ConversionResult {
  const converted = d.converted_files;
  const originalBytes = d.original_bytes;
  const convertedBytes = d.converted_bytes;
  const bytesSaved = Math.max(0, originalBytes - convertedBytes);
  return {
    ok: converted > 0,
    cancelled: d.status === 'cancelled',
    blobs: [],
    failures: [],
    stats: {
      totalFiles: d.total_files,
      convertedFiles: converted,
      failedFiles: d.failed_files,
      originalBytes,
      convertedBytes,
      bytesSaved,
      reductionPercent: originalBytes > 0 ? (bytesSaved / originalBytes) * 100 : 0,
      elapsedSeconds: d.elapsed_seconds,
      outputFolder: d.output_folder ?? null,
    },
  };
}

export class PythonBackend implements ConversionBackend {
  readonly kind = 'python' as const;
  readonly capabilities: BackendCapabilities = {
    kind: 'python',
    folderPick: 'server-browse',
    lossless: true,
    metadataControl: true,
    openOutputFolder: true,
    serverValidate: true,
  };

  async probe(): Promise<boolean> {
    try {
      const res = await fetch('/api/status');
      return res.ok;
    } catch {
      return false;
    }
  }

  async pickFolder(): Promise<SourceSelection | null> {
    return null; // The UI opens the server-side browse modal instead.
  }

  async browse(path: string): Promise<BrowseResult> {
    const res = await fetch('/api/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_folder: path }),
    });
    if (!res.ok) throw new Error('Failed to load folders');
    return res.json();
  }

  async enumerate(selection: SourceSelection): Promise<SourceSummary> {
    const res = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_folder: selection.folderPath ?? '' }),
    });
    const data = await readJson(res);
    const valid = data?.valid ?? false;
    return {
      valid,
      label: selection.label,
      totalFiles: data?.total_files ?? 0,
      totalBytes: data?.total_size_bytes ?? 0,
      collided: 0,
      detail: valid
        ? `${data.total_files} images · ${data.total_size_display}`
        : data?.error ?? 'No convertible images found',
    };
  }

  async convert(
    selection: SourceSelection,
    options: ConversionOptions,
    onProgress: (p: ProgressSnapshot) => void,
  ): Promise<ConversionResult> {
    const payload = {
      source_folder: selection.folderPath,
      quality: options.quality,
      lossless: options.lossless,
      strip_metadata: options.stripMetadata,
    };
    const res = await fetch('/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await readJson(res);
      throw new Error(body?.detail ?? 'Conversion failed to start');
    }

    const snapshot = await new Promise<PythonSnapshot>((resolve, reject) => {
      let settled = false;

      const finish = (snapshot: PythonSnapshot): void => {
        if (settled) return;
        settled = true;
        resolve(snapshot);
      };
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      // Fallback when the SSE stream drops (sleeping tab, flaky proxy, …):
      // keep polling /api/status so a running server-side job is still
      // tracked to its terminal state instead of being orphaned.
      const POLL_INTERVAL_MS = 1_000;
      const MAX_POLL_FAILURES = 5;
      let pollFailures = 0;

      const pollStatus = async (): Promise<void> => {
        if (settled) return;
        try {
          const res = await fetch('/api/status');
          if (!res.ok) throw new Error(String(res.status));
          const data: PythonSnapshot = await res.json();
          pollFailures = 0;
          onProgress(mapProgress(data));
          if (TERMINAL_STATUSES.has(data.status as ProgressSnapshot['status'])) finish(data);
          else setTimeout(() => void pollStatus(), POLL_INTERVAL_MS);
        } catch {
          pollFailures++;
          if (pollFailures >= MAX_POLL_FAILURES) {
            fail(new Error('Lost connection to the conversion'));
          } else {
            setTimeout(() => void pollStatus(), POLL_INTERVAL_MS);
          }
        }
      };

      const source = new EventSource('/progress');
      source.onmessage = (event) => {
        const data: PythonSnapshot = JSON.parse(event.data);
        onProgress(mapProgress(data));
        if (TERMINAL_STATUSES.has(data.status as ProgressSnapshot['status'])) {
          source.close();
          finish(data);
        }
      };
      source.onerror = () => {
        source.close();
        void pollStatus();
      };
    });

    return fromSnapshot(snapshot);
  }

  async cancel(): Promise<void> {
    // A 400 means the conversion already finished , not a failure to cancel.
    const res = await fetch('/convert/cancel', { method: 'POST' });
    if (res.status !== 400 && !res.ok) throw new Error('Failed to cancel');
  }

  async downloadZip(_result: ConversionResult, fileName?: string): Promise<void> {
    const res = await fetch('/api/download-zip');
    if (!res.ok) {
      const body = await readJson(res);
      throw new Error(body?.detail ?? 'Failed to create ZIP');
    }
    triggerDownload(await res.blob(), fileName ?? 'converted-images.zip');
  }

  async openOutputFolder(result: ConversionResult): Promise<void> {
    const path = result.stats.outputFolder;
    if (!path) throw new Error('No output folder');
    const res = await fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_folder: path }),
    });
    if (!res.ok) throw new Error('Could not open folder');
  }

  async convertSingle(file: File, options: ConversionOptions): Promise<FileResult> {
    const form = new FormData();
    form.append('file', file);
    form.append('quality', String(options.quality));
    form.append('lossless', String(options.lossless));
    form.append('strip_metadata', String(options.stripMetadata));

    const res = await fetch('/api/convert-single', { method: 'POST', body: form });
    if (!res.ok) {
      const body = await readJson(res);
      throw new Error(body?.detail ?? 'Conversion failed');
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match = disposition.match(/filename="?(.+?)"?$/);
    const name = match ? match[1] : replaceExtension(file.name, '.webp');
    return {
      name,
      relativePath: name,
      originalSize: file.size,
      convertedSize: blob.size,
      success: true,
      blob,
    };
  }
}