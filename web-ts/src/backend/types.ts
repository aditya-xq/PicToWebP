/**
 * ConversionBackend contract: one UI, two conversion engines.
 *
 * - `browser` — everything happens in the tab (OffscreenCanvas workers, File
 *   System Access, JSZip, localStorage). Used by the static GitHub Pages build.
 * - `python` — a thin client over the local FastAPI server (fetch + SSE +
 *   uploads + server-side ZIP/browse/history). Used by the `build:python`
 *   profile served by `pictowebp-web`.
 *
 * The UI code only ever talks to `ConversionBackend`; capabilities tell it
 * which controls to show and which flows to run.
 */
import type { FileResult } from '../core';
import type { DirEntry } from '../converter';

export type BackendKind = 'browser' | 'python';

export interface BackendCapabilities {
  kind: BackendKind;
  /** How a folder is picked: OS picker (browser) vs server-side browser (python). */
  folderPick: 'fs-access' | 'server-browse';
  /** True lossless encoding (python only; the canvas encoder cannot do it). */
  lossless: boolean;
  /** User control over metadata stripping (python only; browser always strips). */
  metadataControl: boolean;
  /** Open the output folder in the OS explorer (python only). */
  openOutputFolder: boolean;
  /** Where conversion history is stored. */
  historyStore: 'local' | 'server';
  /** Server-side pre-scan of a folder before converting (python only). */
  serverValidate: boolean;
}

export interface ConversionOptions {
  quality: number;
  lossless: boolean;
  stripMetadata: boolean;
}

export interface ConversionStats {
  totalFiles: number;
  convertedFiles: number;
  failedFiles: number;
  originalBytes: number;
  convertedBytes: number;
  bytesSaved: number;
  reductionPercent: number;
  elapsedSeconds: number;
  outputFolder: string | null;
}

export interface ConversionResult {
  /** True when at least one file converted. */
  ok: boolean;
  cancelled: boolean;
  stats: ConversionStats;
  /** Encoded files (browser) — empty for the python backend. */
  blobs: FileResult[];
  failures: { name: string; reason: string }[];
}

export type ProgressStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ProgressSnapshot {
  status: ProgressStatus;
  processed: number;
  total: number;
  elapsedSeconds: number;
  fraction: number;
  etaSeconds: number | null;
  error?: string;
}

/** A folder (or set of files) selected by the user, in backend-specific terms. */
export interface SourceSelection {
  /** Human-readable label (folder name or "Dropped files"). */
  label: string;
  /** python: server-side path of the source folder. */
  folderPath?: string;
  /** browser: lazy entries behind a File System Access handle / dropped files. */
  entries?: DirEntry[];
  /** browser: directory handle for a lazily-walked picked folder. */
  dirHandle?: FileSystemDirectoryHandle;
}

export interface SourceSummary {
  valid: boolean;
  label: string;
  totalFiles: number;
  totalBytes: number;
  collided: number;
  /** Human-readable one-liner for the source badge. */
  detail: string;
}

export interface BrowseResult {
  current: string;
  parent: string | null;
  drives: string[];
  entries: { name: string; path: string }[];
}

export interface HistoryEntry {
  id: string;
  name: string;
  files: string;
  saved: string;
  percent: string;
  elapsed: string;
  timestamp: number;
}

export const TERMINAL_STATUSES: ReadonlySet<ProgressStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export interface ConversionBackend {
  readonly kind: BackendKind;
  readonly capabilities: BackendCapabilities;

  /** Returns false when the backend cannot operate (no WebP support / unreachable). */
  probe(): Promise<boolean>;

  /** Browser: open the OS folder picker. Python: returns null (browse modal used). */
  pickFolder(): Promise<SourceSelection | null>;

  /** Python: list subdirectories for the server-side file browser. */
  browse(path: string): Promise<BrowseResult>;

  /** Count/preview a selected source (browser: walk entries; python: validate). */
  enumerate(selection: SourceSelection): Promise<SourceSummary>;

  /** Convert the whole selection, streaming progress snapshots. */
  convert(
    selection: SourceSelection,
    options: ConversionOptions,
    onProgress: (p: ProgressSnapshot) => void,
  ): Promise<ConversionResult>;

  cancel(): Promise<void>;

  /** Download a ZIP of the conversion output. */
  downloadZip(result: ConversionResult): Promise<void>;

  /** Python: open the server-side output folder in the OS explorer. */
  openOutputFolder(result: ConversionResult): Promise<void>;

  /** Convert a single image (upload in python mode, in-tab in browser mode). */
  convertSingle(file: File, options: ConversionOptions): Promise<FileResult>;

  getHistory(): Promise<HistoryEntry[]>;
  clearHistory(): Promise<void>;
}

export type { FileResult, DirEntry };