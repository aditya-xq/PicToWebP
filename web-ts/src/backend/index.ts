/**
 * Backend selection: a build-time constant chosen by the Vite profile.
 *
 * - Static build (GitHub Pages): `VITE_BACKEND` unset → browser backend.
 * - Python build (`npm run build:python`): `.env.python` sets
 *   `VITE_BACKEND=python` → Python backend.
 *
 * Picking at build time keeps the static build's strict CSP
 * (`connect-src 'none'`) intact — no runtime probing of any network origin.
 */
import { BrowserBackend } from './browser';
import { PythonBackend } from './python';
import type { BackendKind, ConversionBackend } from './types';

export function createBackend(): ConversionBackend {
  const kind: BackendKind = import.meta.env.VITE_BACKEND === 'python' ? 'python' : 'browser';
  return kind === 'python' ? new PythonBackend() : new BrowserBackend();
}

export type {
  BackendCapabilities,
  BackendKind,
  BrowseResult,
  ConversionBackend,
  ConversionOptions,
  ConversionResult,
  ConversionStats,
  HistoryEntry,
  ProgressSnapshot,
  SourceSelection,
  SourceSummary,
} from './types';