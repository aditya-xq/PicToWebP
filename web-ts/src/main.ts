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
import { formatBytes, formatDuration, isSupportedImage } from './core';
import { $ } from './ui/dom';
import { clearHistory, closeHistory, openHistory } from './ui/history';
import { entriesFromDrop, hasFiles } from './ui/drop';
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
let previewUrl: string | null = null;
let dragDepth = 0;

/* ------------------------------ Helpers ------------------------------ */

function showState(next: AppState): void {
  for (const s of ['idle', 'running', 'complete', 'error']) {
    $(`state-${s}`).classList.toggle('hidden', s !== next);
  }
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
  ($('convert-btn') as HTMLButtonElement).disabled = !selection || !selectionValid || isConverting;
}

function getOptions(): ConversionOptions {
  const resizeActive = $('toggle-resize').classList.contains('active');
  const width = ($('resize-width') as HTMLInputElement).valueAsNumber;
  const height = ($('resize-height') as HTMLInputElement).valueAsNumber;
  const losslessEl = document.getElementById('toggle-lossless');
  const metadataEl = document.getElementById('toggle-metadata');
  return {
    quality: Number(($('quality-slider') as HTMLInputElement).value),
    lossless: cap.lossless && (losslessEl?.classList.contains('active') ?? false),
    stripMetadata: cap.metadataControl ? (metadataEl?.classList.contains('active') ?? true) : true,
    resizeWidth: resizeActive && Number.isFinite(width) ? width : null,
    resizeHeight: resizeActive && Number.isFinite(height) ? height : null,
  };
}

/* ------------------------------ Toggles ------------------------------ */

function bindToggle(el: HTMLElement, onChange?: () => void): void {
  el.addEventListener('click', () => {
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
    info.textContent = summary.valid
      ? summary.detail
      : sel.entries?.length === 0 && cap.kind === 'browser'
        ? 'No supported images found'
        : summary.detail;
    if (!summary.valid) info.classList.add('invalid');
  } catch {
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
  try {
    const sel = await backend.pickFolder();
    if (sel) await setSource(sel);
  } catch (err) {
    if ((err as Error).name !== 'AbortError') showToast('Could not open folder', 'error');
  }
}

/* ----------------------------- Conversion ----------------------------- */

function renderProgress(p: ProgressSnapshot): void {
  $('progress-bar').style.width = `${Math.round(p.fraction * 100)}%`;
  $('progress-percent').textContent = `${Math.round(p.fraction * 100)}%`;
  $('running-processed').textContent = String(p.processed);
  $('running-total').textContent = String(p.total);
  $('running-elapsed').textContent = `${formatDuration(p.elapsedSeconds)} elapsed`;
  $('running-eta').textContent = p.etaSeconds === null ? '--' : formatDuration(p.etaSeconds);
}

async function startConversion(): Promise<void> {
  if (isConverting || mode !== 'folder' || !selection || !selectionValid) return;
  isConverting = true;
  updateConvertButton();
  showState('running');
  updateConvertButton();
  showToast('Converting to WebP...', 'info');

  const options = getOptions();
  const sel = selection;
  try {
    const done = await backend.convert(sel, options, renderProgress);
    isConverting = false;
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
          : 'WebP conversion complete!',
        done.cancelled ? 'warn' : 'success',
      );
    }
  } catch (err) {
    isConverting = false;
    showState('error');
    $('error-message').textContent = err instanceof Error ? err.message : String(err);
    showToast('Conversion failed', 'error');
  }
}

function showComplete(done: ConversionResult): void {
  showState('complete');
  const stats = done.stats;
  const percent = stats.reductionPercent.toFixed(1);

  $('complete-time').textContent = `Finished in ${formatDuration(stats.elapsedSeconds)}`;
  $('stat-saved').textContent = formatBytes(stats.bytesSaved);
  $('stat-saved-pct').textContent = `${percent}% reduction`;
  $('stat-converted').textContent = `${stats.convertedFiles} / ${stats.totalFiles}`;
  $('stat-failed').textContent = stats.failedFiles > 0 ? `${stats.failedFiles} failed` : 'All successful';
  $('stat-original').textContent = formatBytes(stats.originalBytes);
  $('stat-new').textContent = formatBytes(stats.convertedBytes);

  const collisions = done.failures.filter((f) => f.reason.includes('collision')).length;
  const note = $('collisions-note');
  if (collisions > 0) {
    note.textContent = `${collisions} file(s) skipped: multiple inputs map to the same .webp output name.`;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }

  const outputFolder = stats.outputFolder;
  $('stat-output-folder').classList.toggle('hidden', !outputFolder);
  if (outputFolder) $('stat-output-path').textContent = outputFolder;
  ($('open-folder-btn') as HTMLButtonElement).classList.toggle('hidden', !cap.openOutputFolder || !outputFolder);
  ($('save-folder-btn') as HTMLButtonElement).classList.toggle('hidden', !cap.saveToFolder || done.blobs.length === 0);

  lastStats = {
    saved: formatBytes(stats.bytesSaved),
    percent,
    files: `${stats.convertedFiles} / ${stats.totalFiles}`,
    elapsed: formatDuration(stats.elapsedSeconds),
    quality: Number(($('quality-slider') as HTMLInputElement).value),
    original: formatBytes(stats.originalBytes),
    webp: formatBytes(stats.convertedBytes),
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
  showState('idle');
  selection = null;
  selectionValid = false;
  result = null;
  $('progress-bar').style.width = '0%';
  $('source-badge').classList.add('hidden');
  updateConvertButton();
  setMode('folder');
  $('single-upload').classList.remove('hidden');
  $('single-converting').classList.add('hidden');
  $('single-result').classList.add('hidden');
  ($('single-file-input') as HTMLInputElement).value = '';
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
}

/* ------------------------------ Results ------------------------------ */

async function saveToFolder(): Promise<void> {
  if (!result || result.blobs.length === 0) {
    showToast('No converted files to save', 'error');
    return;
  }
  try {
    const { written, failed } = await backend.saveToFolder(result);
    if (failed.length > 0) {
      showToast(`Saved ${written} files; failed to write ${failed.length} (you can retry)`, 'warn');
    } else {
      showToast(`Saved ${written} files`, 'success');
      releaseBlobs();
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') showToast('Could not write files', 'error');
  }
}

async function downloadZip(): Promise<void> {
  if (!result) {
    showToast('Nothing to download yet', 'error');
    return;
  }
  showToast('Preparing ZIP...', 'info');
  try {
    await backend.downloadZip(result);
    showToast('ZIP downloaded', 'success');
    if (cap.kind === 'browser') releaseBlobs();
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to create ZIP', 'error');
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
  if (result.blobs.every((r) => !r.blob)) {
    showToast('In-memory copies released — use Convert More for a new batch', 'info');
  }
}

/* --------------------------- Single image --------------------------- */

function handleSingleFile(file: File): void {
  if (!file.type.startsWith('image/') && !isSupportedImage(file.name)) {
    showToast('Please select an image file', 'error');
    return;
  }
  if (mode !== 'single') setMode('single');
  $('single-upload').classList.add('hidden');
  $('single-converting').classList.remove('hidden');

  const options = getOptions();
  backend
    .convertSingle(file, options)
    .then((r) => {
      if (!r.success || !r.blob) throw new Error(r.error ?? 'Conversion failed');
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(r.blob);
      ($('single-preview-img') as HTMLImageElement).src = previewUrl;
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
      showToast(err.message || 'Conversion failed', 'error');
    });
}

function convertAnotherSingle(): void {
  $('single-result').classList.add('hidden');
  $('single-upload').classList.remove('hidden');
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  ($('single-preview-img') as HTMLImageElement).src = '';
  ($('single-file-input') as HTMLInputElement).value = '';
}

/* --------------------------- Browse modal (python) --------------------------- */

let browseCurrentPath = '';
let browseSelected = '';

function openBrowse(): void {
  if (isConverting) return;
  $('browse-modal').classList.remove('hidden');
  browseSelected = '';
  $('browse-selected').textContent = 'Navigate to a folder';
  ($('browse-select-btn') as HTMLButtonElement).disabled = true;
  void browseTo(selection?.folderPath ?? '');
}

function closeBrowse(): void {
  $('browse-modal').classList.add('hidden');
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
  if (!cap.saveToFolder) $('save-folder-btn').classList.add('hidden');

  // Quality
  const slider = $('quality-slider') as HTMLInputElement;
  slider.addEventListener('input', () => {
    $('quality-value').textContent = slider.value;
    slider.setAttribute('aria-valuetext', `${slider.value} out of 100`);
    updateSliderFill();
  });
  updateSliderFill();
  document.querySelectorAll<HTMLButtonElement>('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      slider.value = btn.dataset.preset!;
      $('quality-value').textContent = slider.value;
      updateSliderFill();
    });
  });

  // Toggles
  if (cap.lossless) bindToggle($('toggle-lossless'));
  if (cap.metadataControl) bindToggle($('toggle-metadata'));
  const resizeToggle = $('toggle-resize');
  bindToggle(resizeToggle, () => $('resize-inputs').classList.toggle('hidden'));

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
  singleZone.addEventListener('click', () => ($('single-file-input') as HTMLInputElement).click());
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
  wireZoneKeyboard(singleZone, () => ($('single-file-input') as HTMLInputElement).click());
  ($('single-file-input') as HTMLInputElement).addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) handleSingleFile(file);
  });

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
  $('save-folder-btn').addEventListener('click', () => void saveToFolder());
  $('download-zip-btn').addEventListener('click', () => void downloadZip());
  $('open-folder-btn').addEventListener('click', () => void openOutputFolder());
  $('share-btn').addEventListener('click', () => {
    if (lastStats) shareStats(lastStats);
  });
  $('convert-another-btn').addEventListener('click', convertAnotherSingle);

  // History
  $('history-btn').addEventListener('click', () => void openHistory(backend));
  $('history-close-btn').addEventListener('click', closeHistory);
  $('history-overlay').addEventListener('click', closeHistory);
  $('history-clear-btn').addEventListener('click', () => void clearHistory(backend));

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
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void startConversion();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void startConversion();
    } else if (e.key === 'Escape') {
      if (!$('browse-modal').classList.contains('hidden')) closeBrowse();
      else if (!$('shortcuts-modal').classList.contains('hidden')) showShortcuts(false);
      else if (!$('history-panel').classList.contains('hidden')) closeHistory();
      else if (isConverting) void cancelConversion();
    } else if (e.key === 'h' || e.key === 'H') void openHistory(backend);
    else if (e.key === 'b' || e.key === 'B') void selectFolder();
    else if (e.key === '?') showShortcuts(true);
  });

  document.addEventListener('paste', (e) => {
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