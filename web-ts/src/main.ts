// Single UI for PicToWebP. The conversion engine behind it is chosen at build
// time by the Vite profile: static build → in-browser workers, python build →
// the local FastAPI server. All UI code talks to the ConversionBackend contract.
import './ui.css';
import { createBackend } from './backend';
import type {
  ConversionBackend,
  ConversionOptions,
  ConversionResult,
  ProgressSnapshot,
  SourceSelection,
} from './backend';
import {
  estimateWebpBytes,
  formatBytes,
  formatDuration,
  hasHiddenDirectorySegment,
  isSupportedImage,
} from './core';
import { $ } from './ui/dom';
import { entriesFromDrop, hasFiles } from './ui/drop';
import { setFocusTrap } from './ui/focus';
import { shareStats, type ShareStats } from './ui/share';
import { showToast } from './ui/toasts';

type Mode = 'folder' | 'single';
type AppState = 'idle' | 'running' | 'complete' | 'error';

const backend: ConversionBackend = createBackend();
const cap = backend.capabilities;

let mode: Mode = 'folder';
let isConverting = false;
let selection: SourceSelection | null = null;
let selectionValid = false;
let result: ConversionResult | null = null;
let lastStats: ShareStats | null = null;
let lastSummary: {
  detail: string;
  valid: boolean;
  totalBytes: number;
  totalFiles: number;
} | null = null;
let previewUrl: string | null = null;
let origUrl: string | null = null;
let dragDepth = 0;

/* ------------------------------ Helpers ------------------------------ */

function showState(next: AppState): void {
  for (const s of ['idle', 'running', 'complete', 'error']) {
    $(`state-${s}`).classList.toggle('hidden', s !== next);
  }
  $('state-running').setAttribute('aria-busy', String(next === 'running'));
  if (next === 'running') {
    const btn = $('cancel-btn') as HTMLButtonElement;
    btn.disabled = false;
    btn.textContent = 'Cancel';
  }
}

function setMode(next: Mode): void {
  mode = next;
  for (const tab of document.querySelectorAll('.mode-tab')) {
    tab.classList.toggle('active', (tab as HTMLElement).dataset.mode === next);
  }
  $('mode-folder').classList.toggle('hidden', next !== 'folder');
  $('mode-single').classList.toggle('hidden', next !== 'single');
}

function updateSliderFill(): void {
  const slider = $('quality-slider') as HTMLInputElement;
  const pct = ((Number(slider.value) - 1) / 99) * 100;
  slider.style.background = `linear-gradient(90deg, var(--brand-500) 0%, var(--brand-500) ${pct}%, var(--track-tail) ${pct}%, var(--track-tail) 100%)`;
}

function updateConvertButton(): void {
  const btn = $('convert-btn') as HTMLButtonElement;
  // Browser selections carry their entries up front; the python edition only
  // learns the count after the server-side scan (lastSummary.totalFiles).
  const count = selection?.entries?.length ?? lastSummary?.totalFiles ?? 0;
  const ready = Boolean(selection) && selectionValid;
  btn.disabled = !ready || isConverting;
  btn.textContent =
    ready && count > 0 ? `Convert ${count} Image${count === 1 ? '' : 's'}` : 'Convert to WebP';
}

/** Rebuild the source badge line, appending a live output-size estimate. */
function renderSourceInfo(): void {
  if (!lastSummary) return;
  const info = $('source-info');
  const parts = [lastSummary.detail];
  if (lastSummary.valid && lastSummary.totalBytes > 0) {
    const losslessOn =
      cap.lossless && document.getElementById('toggle-lossless')?.classList.contains('active');
    if (!losslessOn) {
      const quality = Number(($('quality-slider') as HTMLInputElement).value);
      const est = estimateWebpBytes(lastSummary.totalBytes, quality);
      if (est > 0) parts.push(`≈ ${formatBytes(est)} output`);
    }
  }
  info.textContent = parts.join(' · ');
  info.classList.toggle('invalid', !lastSummary.valid);
}

/** Move the single-image compare divider to `value` (0-100). */
function setComparePos(value: number): void {
  $('compare-stage').style.setProperty('--compare-pos', String(value / 100));
}

/** Animate a stat number from 0 up to `target` with cubic ease-out. */
function animateCount(el: HTMLElement, target: number, duration = 900, suffix = ''): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = `${target.toFixed(1)}${suffix}`;
    return;
  }
  const start = performance.now();
  const frame = (now: number): void => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = `${(target * eased).toFixed(1)}${suffix}`;
    if (t < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Copy a string to the clipboard (Web API with a legacy fallback). */
async function copyText(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Path copied', 'success');
    return;
  } catch {
    // Legacy path for contexts where the async Clipboard API is unavailable.
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(ta);
  showToast(copied ? 'Path copied' : 'Could not copy path', copied ? 'success' : 'error');
}

/**
 * Freeze every control that could mutate the conversion settings or start a
 * second job while one is running. Options are captured when a conversion
 * starts, so changing them mid-run would silently do nothing — hiding the
 * affordance is kinder than ignoring the input.
 */
function setBusy(busy: boolean): void {
  ($('quality-slider') as HTMLInputElement).disabled = busy;
  document.querySelectorAll<HTMLButtonElement>('.preset-btn, .mode-tab').forEach((btn) => {
    btn.disabled = busy;
  });
  for (const id of ['toggle-lossless', 'toggle-metadata']) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.toggle('disabled', busy);
      el.setAttribute('aria-disabled', String(busy));
    }
  }
  for (const id of ['drop-zone', 'single-drop-zone']) {
    $(id).classList.toggle('disabled', busy);
    $(id).setAttribute('aria-disabled', String(busy));
  }
}

function getOptions(): ConversionOptions {
  const losslessEl = document.getElementById('toggle-lossless');
  const metadataEl = document.getElementById('toggle-metadata');
  return {
    quality: Number(($('quality-slider') as HTMLInputElement).value),
    lossless: cap.lossless && (losslessEl?.classList.contains('active') ?? false),
    stripMetadata: cap.metadataControl ? (metadataEl?.classList.contains('active') ?? true) : true,
  };
}

/* ------------------------------ Toggles ------------------------------ */

function bindToggle(el: HTMLElement, onChange?: () => void): void {
  el.addEventListener('click', () => {
    if (isConverting) return;
    el.classList.toggle('active');
    el.setAttribute('aria-checked', String(el.classList.contains('active')));
    onChange?.();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      el.click();
    }
  });
}

/* --------------------------- Source selection --------------------------- */

async function setSource(sel: SourceSelection): Promise<void> {
  selection = sel;
  const badge = $('source-badge');
  badge.classList.remove('hidden');
  $('idle-hint').classList.add('hidden');
  $('source-path').textContent = sel.label;
  $('source-path').title = sel.label;

  const info = $('source-info');
  info.classList.remove('invalid');
  info.textContent = 'Scanning…';
  selectionValid = false;
  updateConvertButton();

  try {
    const summary = await backend.enumerate(sel);
    selection = sel;
    selectionValid = summary.valid;
    lastSummary = {
      detail: summary.valid
        ? summary.detail
        : sel.entries?.length === 0 && cap.kind === 'browser'
          ? 'No supported images found'
          : summary.detail,
      valid: summary.valid,
      totalBytes: summary.totalBytes,
      totalFiles: summary.totalFiles,
    };
    renderSourceInfo();
  } catch {
    lastSummary = null;
    info.textContent = 'Could not read the folder';
    info.classList.add('invalid');
    selectionValid = false;
  }
  updateConvertButton();
}

async function selectFolder(): Promise<void> {
  if (isConverting) return;
  if (cap.folderPick === 'server-browse') {
    openBrowse();
    return;
  }
  // File System Access API (Chromium); fall back to a plain multi-file
  // input (with directory picking) on Firefox / iOS where it is missing.
  if ('showDirectoryPicker' in window) {
    try {
      const sel = await backend.pickFolder();
      if (sel) await setSource(sel);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') showToast('Could not open folder', 'error');
    }
    return;
  }
  const input = $('folder-fallback-input') as HTMLInputElement;
  input.value = '';
  input.click();
}

function pickViaFallbackInput(): void {
  const input = $('folder-fallback-input') as HTMLInputElement;
  // Skip hidden directories so directory picking matches the handle-based
  // enumeration and the CLIs (dot-prefixed folders are never converted).
  const files = Array.from(input.files ?? [])
    .filter((f) => isSupportedImage(f.name))
    .filter((f) => !hasHiddenDirectorySegment(f.webkitRelativePath || f.name))
    .map((f) => ({ file: f, relativePath: f.webkitRelativePath || f.name }));
  if (files.length === 0) {
    showToast('No supported images found', 'warn');
    return;
  }
  const first = files[0].relativePath;
  const label = first.includes('/') ? first.slice(0, first.indexOf('/')) : 'Selected files';
  void setSource({ label, entries: files });
}

/* ----------------------------- Conversion ----------------------------- */

function renderProgress(p: ProgressSnapshot): void {
  $('progress-bar').style.width = `${Math.round(p.fraction * 100)}%`;
  $('progress-percent').textContent = `${Math.round(p.fraction * 100)}%`;
  $('running-processed').textContent = String(p.processed);
  $('running-total').textContent = String(p.total);
  $('running-elapsed').textContent = `${formatDuration(p.elapsedSeconds)} elapsed`;
  $('running-eta').textContent = p.etaSeconds === null ? '--' : formatDuration(p.etaSeconds);

  const nameEl = $('running-file-name');
  if (p.currentFile) {
    const short = p.currentFile.split(/[/\\]/).pop() ?? p.currentFile;
    nameEl.textContent = short;
    nameEl.title = p.currentFile;
  } else {
    // No in-flight file (start of run / between chunks) — drop any stale name.
    nameEl.textContent = '';
    nameEl.title = '';
  }

  // Announce progress in bursts so screen readers aren't spammed every tick.
  if (p.processed === 1 || p.processed % 5 === 0 || p.processed === p.total) {
    $('progress-live').textContent = `${p.processed} of ${p.total} images converted`;
  }
}

async function startConversion(): Promise<void> {
  if (isConverting || mode !== 'folder' || !selection || !selectionValid) return;
  // Drop any in-memory blobs from a previous run before starting a new one.
  releaseBlobs();
  result = null;
  isConverting = true;
  setBusy(true);
  updateConvertButton();
  showState('running');
  updateConvertButton();
  showToast('Converting to WebP...', 'info');

  const options = getOptions();
  const sel = selection;
  try {
    const done = await backend.convert(sel, options, renderProgress);
    isConverting = false;
    setBusy(false);
    result = done;
    if (done.cancelled && !done.ok) {
      showState('idle');
      showToast('Conversion cancelled', 'warn');
    } else if (done.stats.convertedFiles === 0 && done.stats.failedFiles > 0) {
      showState('error');
      $('error-message').textContent = 'No images could be converted.';
    } else {
      showComplete(done);
      showToast(
        done.cancelled
          ? `Cancelled — ${done.stats.convertedFiles} converted file${done.stats.convertedFiles === 1 ? '' : 's'} kept`
          : done.stats.bytesSaved > 0
            ? `Saved ${formatBytes(done.stats.bytesSaved)} (${done.stats.reductionPercent.toFixed(1)}% smaller)`
            : 'WebP conversion complete!',
        done.cancelled ? 'warn' : 'success',
      );
    }
  } catch (err) {
    isConverting = false;
    setBusy(false);
    showState('error');
    $('error-message').textContent = err instanceof Error ? err.message : String(err);
    showToast('Conversion failed', 'error');
  }
}

/** Render the skipped/failed file list in a collapsible section. */
function renderFailures(failures: { name: string; reason: string }[]): void {
  const details = $('failures-details');
  const list = $('failures-list');
  list.textContent = '';
  if (failures.length === 0) {
    details.classList.add('hidden');
    return;
  }
  const MAX_SHOWN = 100;
  for (const failure of failures.slice(0, MAX_SHOWN)) {
    const row = document.createElement('div');
    row.className = 'failure-row';
    const name = document.createElement('span');
    name.className = 'failure-name truncate';
    name.textContent = failure.name;
    name.title = failure.name;
    const reason = document.createElement('span');
    reason.className = 'failure-reason truncate';
    reason.textContent = failure.reason;
    reason.title = failure.reason;
    row.append(name, reason);
    list.appendChild(row);
  }
  if (failures.length > MAX_SHOWN) {
    const more = document.createElement('p');
    more.className = 'failure-more';
    more.textContent = `…and ${failures.length - MAX_SHOWN} more`;
    list.appendChild(more);
  }
  $('failures-summary').textContent =
    `${failures.length} file${failures.length === 1 ? '' : 's'} skipped or failed`;
  details.classList.remove('hidden');
}

function showComplete(done: ConversionResult): void {
  showState('complete');
  const stats = done.stats;
  const percent = stats.reductionPercent.toFixed(1);

  $('complete-time').textContent = `Finished in ${formatDuration(stats.elapsedSeconds)}`;
  $('stat-saved').textContent = formatBytes(stats.bytesSaved);
  animateCount($('stat-saved-pct'), stats.reductionPercent, 900, '% reduction');
  $('stat-converted').textContent = `${stats.convertedFiles} / ${stats.totalFiles}`;
  const notProcessed = done.cancelled
    ? Math.max(0, stats.totalFiles - stats.convertedFiles - stats.failedFiles)
    : 0;
  const failedParts: string[] = [];
  if (stats.failedFiles > 0) failedParts.push(`${stats.failedFiles} failed`);
  if (notProcessed > 0) failedParts.push(`${notProcessed} not processed`);
  $('stat-failed').textContent =
    failedParts.length > 0 ? failedParts.join(' · ') : 'All successful';
  $('stat-original').textContent = formatBytes(stats.originalBytes);
  $('stat-new').textContent = formatBytes(stats.convertedBytes);

  // Size comparison bars + staggered card reveal (animated after the state
  // pane is visible again).
  const maxBytes = Math.max(stats.originalBytes, stats.convertedBytes, 1);
  requestAnimationFrame(() => {
    $('cmp-bar-orig').style.width = `${(stats.originalBytes / maxBytes) * 100}%`;
    $('cmp-bar-webp').style.width = `${(stats.convertedBytes / maxBytes) * 100}%`;
    $('cmp-val-orig').textContent = formatBytes(stats.originalBytes);
    $('cmp-val-webp').textContent = formatBytes(stats.convertedBytes);
  });
  document.querySelectorAll<HTMLElement>('.stat-card').forEach((card, i) => {
    card.classList.remove('pop');
    void card.offsetWidth;
    card.style.animationDelay = `${i * 70}ms`;
    card.classList.add('pop');
  });

  const collisions = done.failures.filter((f) => f.reason.includes('collision')).length;
  const note = $('collisions-note');
  if (collisions > 0) {
    note.textContent = `${collisions} file(s) skipped: multiple inputs map to the same .webp output name.`;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }
  renderFailures(done.failures);

  const outputFolder = stats.outputFolder;
  $('stat-output-folder').classList.toggle('hidden', !outputFolder);
  if (outputFolder) $('stat-output-path').textContent = outputFolder;
  ($('open-folder-btn') as HTMLButtonElement).classList.toggle('hidden', !cap.openOutputFolder || !outputFolder);

  lastStats = {
    saved: formatBytes(stats.bytesSaved),
    percent,
    files: `${stats.convertedFiles} / ${stats.totalFiles}`,
    elapsed: formatDuration(stats.elapsedSeconds),
    quality: Number(($('quality-slider') as HTMLInputElement).value),
    original: formatBytes(stats.originalBytes),
    webp: formatBytes(stats.convertedBytes),
    edition: cap.kind,
  };
}

async function cancelConversion(): Promise<void> {
  if (!isConverting) return;
  const btn = $('cancel-btn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Cancelling...';
  showToast('Finishing in-flight conversions...', 'warn');
  try {
    await backend.cancel();
  } catch {
    showToast('Failed to cancel', 'error');
  }
}

function resetUI(): void {
  releaseBlobs();
  showState('idle');
  selection = null;
  selectionValid = false;
  result = null;
  lastSummary = null;
  $('progress-bar').style.width = '0%';
  $('source-badge').classList.add('hidden');
  $('idle-hint').classList.remove('hidden');
  updateConvertButton();
  setMode('folder');
  $('single-upload').classList.remove('hidden');
  $('single-converting').classList.add('hidden');
  $('single-result').classList.add('hidden');
  ($('single-file-input') as HTMLInputElement).value = '';
  revokePreviewUrls();
}

/* ------------------------------ Results ------------------------------ */

async function downloadZip(): Promise<void> {
  if (!result) {
    showToast('Nothing to download yet', 'error');
    return;
  }
  const btn = $('download-zip-btn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Preparing ZIP…';
  showToast('Preparing ZIP...', 'info');
  try {
    await backend.downloadZip(result);
    showToast('ZIP downloaded', 'success');
    if (cap.kind === 'browser') releaseBlobs();
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to create ZIP', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download ZIP';
  }
}

async function openOutputFolder(): Promise<void> {
  if (!result) return;
  try {
    await backend.openOutputFolder(result);
    showToast('Folder opened', 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Could not open folder', 'error');
  }
}

function releaseBlobs(): void {
  if (!result) return;
  for (const entry of result.blobs) entry.blob = undefined;
}

/** Free both single-mode preview object URLs (converted + original). */
function revokePreviewUrls(): void {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  if (origUrl) {
    URL.revokeObjectURL(origUrl);
    origUrl = null;
  }
}

/* --------------------------- Single image --------------------------- */

function handleSingleFile(file: File): void {
  if (isConverting) return;
  if (!file.type.startsWith('image/') && !isSupportedImage(file.name)) {
    showToast('Please select an image file', 'error');
    return;
  }
  if (mode !== 'single') setMode('single');
  isConverting = true;
  setBusy(true);
  $('single-upload').classList.add('hidden');
  $('single-converting').classList.remove('hidden');

  const options = getOptions();
  backend
    .convertSingle(file, options)
    .then((r) => {
      if (!r.success || !r.blob) throw new Error(r.error ?? 'Conversion failed');
      revokePreviewUrls();
      previewUrl = URL.createObjectURL(r.blob);
      origUrl = URL.createObjectURL(file);
      ($('single-preview-img') as HTMLImageElement).src = previewUrl;
      ($('cmp-orig') as HTMLImageElement).src = origUrl;
      setComparePos(50);
      ($('compare-slider') as HTMLInputElement).value = '50';
      const download = $('single-download-btn') as HTMLAnchorElement;
      download.href = previewUrl;
      download.download = r.name;
      const savedPct = Math.max(0, (1 - r.convertedSize / r.originalSize) * 100).toFixed(0);
      $('single-result-info').textContent =
        `${formatBytes(r.originalSize)} → ${formatBytes(r.convertedSize)} (${savedPct}% smaller)`;
      $('single-converting').classList.add('hidden');
      $('single-result').classList.remove('hidden');
    })
    .catch((err: Error) => {
      $('single-converting').classList.add('hidden');
      $('single-upload').classList.remove('hidden');
      revokePreviewUrls();
      showToast(err.message || 'Conversion failed', 'error');
    })
    .finally(() => {
      isConverting = false;
      setBusy(false);
    });
}

function convertAnotherSingle(): void {
  $('single-result').classList.add('hidden');
  $('single-upload').classList.remove('hidden');
  revokePreviewUrls();
  ($('single-preview-img') as HTMLImageElement).src = '';
  ($('cmp-orig') as HTMLImageElement).src = '';
  ($('single-download-btn') as HTMLAnchorElement).href = '#';
  ($('single-file-input') as HTMLInputElement).value = '';
}

/* --------------------------- Browse modal (python) --------------------------- */

let browseCurrentPath = '';
let browseSelected = '';

function openBrowse(): void {
  if (isConverting) return;
  const modal = $('browse-modal');
  modal.classList.remove('hidden');
  browseSelected = '';
  $('browse-selected').textContent = 'Navigate to a folder';
  ($('browse-select-btn') as HTMLButtonElement).disabled = true;
  setFocusTrap(modal, true);
  // The overlay itself isn't focusable — land focus on the dialog body.
  (modal.querySelector('.browse-modal-body') as HTMLElement | null)?.focus();
  void browseTo(selection?.folderPath ?? '');
}

function closeBrowse(): void {
  $('browse-modal').classList.add('hidden');
  setFocusTrap($('browse-modal'), false);
}

async function browseTo(path: string): Promise<void> {
  try {
    const d = await backend.browse(path);
    $('browse-current').textContent = d.current;
    browseCurrentPath = d.current;

    const list = $('browse-list');
    list.textContent = '';

    // `drives` is only present on the initial "This PC" listing — normalize
    // so ordinary directory listings (no drives key) don't crash the modal.
    const drives = d.drives ?? [];

    for (const drive of drives) {
      const btn = document.createElement('button');
      btn.className = 'browse-item';
      btn.innerHTML = '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg><span></span>';
      btn.querySelector('span')!.textContent = drive;
      btn.addEventListener('click', () => void browseTo(drive));
      list.appendChild(btn);
    }

    if (d.parent) {
      const btn = document.createElement('button');
      btn.className = 'browse-item';
      btn.innerHTML = '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7"/></svg><span>..</span>';
      btn.addEventListener('click', () => void browseTo(d.parent!));
      list.appendChild(btn);
    }

    for (const entry of d.entries) {
      const btn = document.createElement('button');
      btn.className = 'browse-item';
      btn.innerHTML = '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg><span></span>';
      btn.querySelector('span')!.textContent = entry.name;
      btn.addEventListener('click', () => void browseTo(entry.path));
      list.appendChild(btn);
    }

    if (!drives.length && !d.parent && d.entries.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = 'No subdirectories';
      list.appendChild(p);
    }

    if (d.current !== 'This PC') {
      browseSelected = d.current;
      $('browse-selected').textContent = d.current;
      ($('browse-select-btn') as HTMLButtonElement).disabled = false;
    } else {
      browseSelected = '';
      $('browse-selected').textContent = 'Navigate to a folder';
      ($('browse-select-btn') as HTMLButtonElement).disabled = true;
    }
  } catch {
    const list = $('browse-list');
    list.textContent = '';
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'Failed to load';
    list.appendChild(p);
  }
}

/* --------------------------- Drag & drop --------------------------- */

function showDragOverlay(): void {
  $('drag-overlay').classList.remove('hidden');
}

function hideDragOverlay(): void {
  dragDepth = 0;
  $('drag-overlay').classList.add('hidden');
}

/** Route dropped files/folders to the active backend's capabilities. */
async function handleDrop(e: DragEvent): Promise<void> {
  e.preventDefault();
  e.stopPropagation();
  $('drop-zone').classList.remove('drag-over');
  hideDragOverlay();
  if (!e.dataTransfer || isConverting) return;

  if (cap.kind === 'python') {
    // The server can only accept one uploaded image at a time.
    const file = e.dataTransfer.files[0];
    if (file) {
      setMode('single');
      handleSingleFile(file);
    }
    return;
  }

  const entries = await entriesFromDrop(e.dataTransfer.items, e.dataTransfer.files);
  const images = entries.filter((entry) => entry.file);
  if (images.length > 0) {
    await setSource({ label: 'Dropped files', entries: images });
  }
}

/* ------------------------------ Shortcuts ------------------------------ */

function showShortcuts(visible: boolean): void {
  $('shortcuts-modal').classList.toggle('hidden', !visible);
  $('shortcuts-overlay').classList.toggle('hidden', !visible);
  const modal = $('shortcuts-modal');
  setFocusTrap(modal, visible);
  if (visible) modal.focus();
}

/* -------------------------------- Init -------------------------------- */

function wireZoneKeyboard(zone: HTMLElement, activate: () => void): void {
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      activate();
    }
  });
}

function initUI(): void {
  const kind = cap.kind;
  ($('edition-badge') as HTMLElement).textContent = kind === 'python' ? 'Local Server' : 'Browser Edition';
  if (kind === 'python') {
    $('hero-sub').textContent = 'Pick a folder on this machine. Convert to WebP locally.';
    $('drop-zone-sub').textContent = 'click to browse folders on this machine';
    $('drag-overlay-sub').textContent = 'Drop an image to convert — one at a time on the server';
    $('browser-note').classList.add('hidden');
    $('python-note').classList.remove('hidden');
  } else {
    $('python-note').classList.add('hidden');
  }
  if (!cap.metadataControl) {
    $('server-options').classList.add('hidden');
    $('browser-note').classList.remove('hidden');
  }

  // Quality
  const slider = $('quality-slider') as HTMLInputElement;
  slider.addEventListener('input', () => {
    $('quality-value').textContent = slider.value;
    slider.setAttribute('aria-valuetext', `${slider.value} out of 100`);
    updateSliderFill();
    renderSourceInfo();
  });
  updateSliderFill();
  document.querySelectorAll<HTMLButtonElement>('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      slider.value = btn.dataset.preset!;
      $('quality-value').textContent = slider.value;
      updateSliderFill();
      renderSourceInfo();
    });
  });

  // Toggles
  if (cap.lossless) bindToggle($('toggle-lossless'), () => renderSourceInfo());
  if (cap.metadataControl) bindToggle($('toggle-metadata'));

  // Mode tabs
  document.querySelectorAll<HTMLButtonElement>('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => setMode(tab.dataset.mode as Mode));
  });

  // Folder mode
  const dropZone = $('drop-zone');
  dropZone.addEventListener('click', () => void selectFolder());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => void handleDrop(e));
  wireZoneKeyboard(dropZone, () => void selectFolder());

  // Single mode
  const singleZone = $('single-drop-zone');
  singleZone.addEventListener('click', () => {
    if (isConverting) return;
    ($('single-file-input') as HTMLInputElement).click();
  });
  singleZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    singleZone.classList.add('drag-over');
  });
  singleZone.addEventListener('dragleave', () => singleZone.classList.remove('drag-over'));
  singleZone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    singleZone.classList.remove('drag-over');
    hideDragOverlay();
    const file = e.dataTransfer?.files[0];
    if (file) handleSingleFile(file);
  });
  wireZoneKeyboard(singleZone, () => {
    if (isConverting) return;
    ($('single-file-input') as HTMLInputElement).click();
  });
  ($('single-file-input') as HTMLInputElement).addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) handleSingleFile(file);
  });

  // Directory-picking fallback for browsers without the File System Access API.
  const fallbackInput = $('folder-fallback-input') as HTMLInputElement;
  fallbackInput.webkitdirectory = true;
  fallbackInput.addEventListener('change', pickViaFallbackInput);

  // iOS Safari cannot pick whole folders — never promise it in the copy.
  if (!('webkitdirectory' in fallbackInput)) {
    const title = dropZone.querySelector('.dz-title');
    if (title) title.textContent = 'Select images';
    $('drop-zone-sub').textContent = 'or drag images here — everything stays local';
  }

  // Single-image original-vs-WebP compare slider.
  const compareSlider = $('compare-slider') as HTMLInputElement;
  compareSlider.addEventListener('input', () => setComparePos(Number(compareSlider.value)));
  setComparePos(50);

  // Full-window drag overlay
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    showDragOverlay();
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) hideDragOverlay();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hideDragOverlay();
    if (isConverting) return;
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    if (mode === 'single') {
      handleSingleFile(files[0]);
      return;
    }
    if (cap.kind === 'python') {
      setMode('single');
      handleSingleFile(files[0]);
      return;
    }
    void (async () => {
      const entries = await entriesFromDrop(e.dataTransfer!.items, files);
      const images = entries.filter((entry) => entry.file);
      if (images.length > 0) await setSource({ label: 'Dropped files', entries: images });
    })();
  });

  // Actions
  $('convert-btn').addEventListener('click', () => void startConversion());
  $('cancel-btn').addEventListener('click', () => void cancelConversion());
  $('convert-more-btn').addEventListener('click', resetUI);
  $('try-again-btn').addEventListener('click', resetUI);
  $('download-zip-btn').addEventListener('click', () => void downloadZip());
  $('open-folder-btn').addEventListener('click', () => void openOutputFolder());
  $('share-btn').addEventListener('click', () => {
    if (lastStats) void shareStats(lastStats);
  });
  $('convert-another-btn').addEventListener('click', convertAnotherSingle);
  $('copy-path-btn').addEventListener('click', () =>
    void copyText($('stat-output-path').textContent ?? ''),
  );

  // Browse modal (python)
  if (cap.folderPick === 'server-browse') {
    $('browse-up-btn').addEventListener('click', () => {
      if (browseCurrentPath === 'This PC') return;
      const parent = browseCurrentPath.replace(/[/\\][^/\\]+$/, '');
      void browseTo(parent !== browseCurrentPath ? parent : '');
    });
    $('browse-select-btn').addEventListener('click', () => {
      if (browseSelected) void setSource({ label: browseSelected, folderPath: browseSelected });
      closeBrowse();
    });
    $('browse-close-btn').addEventListener('click', closeBrowse);
    $('browse-cancel-btn').addEventListener('click', closeBrowse);
    document.querySelector('#browse-modal .absolute-inset')?.addEventListener('click', closeBrowse);
  }

  // Shortcuts modal
  $('shortcuts-btn').addEventListener('click', () => showShortcuts(true));
  $('shortcuts-close-btn').addEventListener('click', () => showShortcuts(false));
  $('shortcuts-overlay').addEventListener('click', () => showShortcuts(false));

  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    const onActivatable = target instanceof Element && !!target.closest('button, a');
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      if (onActivatable) return;
      e.preventDefault();
      void startConversion();
    } else if (e.key === 'Enter') {
      // Let focused buttons/links handle their own Enter — the global
      // shortcut would double-fire the action.
      if (onActivatable) return;
      e.preventDefault();
      void startConversion();
    } else if (e.key === 'Escape') {
      if (!$('browse-modal').classList.contains('hidden')) closeBrowse();
      else if (!$('shortcuts-modal').classList.contains('hidden')) showShortcuts(false);
      else if (isConverting && mode === 'folder') void cancelConversion();
    } else if (e.key === 'b' || e.key === 'B') void selectFolder();
    else if (e.key === '?') showShortcuts(true);
  });

  document.addEventListener('paste', (e) => {
    // A paste must not yank the UI to single mode while a batch is running —
    // the running state lives in the folder pane and the tabs are busy-locked.
    if (isConverting) return;
    const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
      i.type.startsWith('image/'),
    );
    const file = item?.getAsFile();
    if (!file) return;
    setMode('single');
    handleSingleFile(file);
  });

  // Don't lose an in-flight batch to an accidental tab close.
  window.addEventListener('beforeunload', (e) => {
    if (isConverting) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void backend
    .probe()
    .then((ok) => {
      if (!ok) {
        showToast(
          cap.kind === 'python'
            ? 'Cannot reach the local server. Start it with `pictowebp-web`.'
            : 'Your browser cannot encode WebP. Try a recent Chrome or Edge.',
          'error',
        );
        return;
      }
      initUI();
    })
    .catch(() => showToast('The conversion backend is unavailable', 'error'));
});