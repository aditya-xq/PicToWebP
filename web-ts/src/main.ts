// Shared design system — single source of truth used by the Python web UI too
// (served from src/pictowebp/templates/, packaged with the Python app).
import '../../src/pictowebp/templates/ui.css';
import JSZip from 'jszip';
import {
  FileResult,
  estimateEtaSeconds,
  findCollisions,
  formatBytes,
  formatDuration,
  isSupportedImage,
} from './core';
import {
  DirEntry,
  convertFile,
  enumerateFiles,
  supportsWebpEncoding,
  writeFileToDir,
} from './converter';

type Mode = 'folder' | 'single';
type AppState = 'idle' | 'running' | 'complete' | 'error';

interface HistoryEntry {
  id: string;
  name: string;
  files: string;
  saved: string;
  percent: string;
  elapsed: string;
  timestamp: number;
}

const HISTORY_KEY = 'pictowebp-history';
const HISTORY_LIMIT = 50;
const CONCURRENCY = 4;

let mode: Mode = 'folder';
let isConverting = false;
let cancelRequested = false;
let folderHandle: FileSystemDirectoryHandle | null = null;
let files: DirEntry[] = [];
let results: FileResult[] = [];
let collidedPaths: Set<string> = new Set();
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let startedAt = 0;
let elapsedSeconds = 0;
let lastStats: {
  saved: string;
  percent: string;
  files: string;
  elapsed: string;
  quality: number;
  original: string;
  webp: string;
} | null = null;
let previewUrl: string | null = null;

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
};

document.addEventListener('DOMContentLoaded', () => {
  if (!supportsWebpEncoding()) {
    showToast('Your browser cannot encode WebP. Try a recent Chrome or Edge.', 'error');
    return;
  }
  initUI();
  // Don't lose an in-flight batch to an accidental tab close.
  window.addEventListener('beforeunload', (e) => {
    if (isConverting) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
});

function initUI(): void {
  // Quality
  const slider = $('quality-slider') as HTMLInputElement;
  slider.addEventListener('input', () => {
    $('quality-value').textContent = slider.value;
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

  // Resize toggle
  const resizeToggle = $('toggle-resize');
  const flipResize = () => {
    resizeToggle.classList.toggle('active');
    resizeToggle.setAttribute(
      'aria-checked',
      String(resizeToggle.classList.contains('active')),
    );
    $('resize-inputs').classList.toggle('hidden');
  };
  resizeToggle.addEventListener('click', flipResize);
  resizeToggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      flipResize();
    }
  });

  // Mode tabs
  document.querySelectorAll<HTMLButtonElement>('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => setMode(tab.dataset.mode as Mode));
  });

  // Folder mode
  $('drop-zone').addEventListener('click', pickFolder);
  $('drop-zone').addEventListener('dragover', (e) => onDragOver(e, $('drop-zone')));
  $('drop-zone').addEventListener('dragleave', () => $('drop-zone').classList.remove('drag-over'));
  $('drop-zone').addEventListener('drop', (e) => onDrop(e));

  // Single mode
  $('single-drop-zone').addEventListener('click', () => ($('single-file-input') as HTMLInputElement).click());
  $('single-drop-zone').addEventListener('dragover', (e) => onDragOver(e, $('single-drop-zone')));
  $('single-drop-zone').addEventListener('dragleave', () => $('single-drop-zone').classList.remove('drag-over'));
  $('single-drop-zone').addEventListener('drop', (e) => {
    e.preventDefault();
    $('single-drop-zone').classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    if (file) handleSingleFile(file);
  });
  $('single-file-input').addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) handleSingleFile(file);
  });

  // Actions
  $('convert-btn').addEventListener('click', () => void startConversion());
  $('cancel-btn').addEventListener('click', cancelConversion);
  $('convert-more-btn').addEventListener('click', resetUI);
  $('try-again-btn').addEventListener('click', resetUI);
  $('save-folder-btn').addEventListener('click', () => void saveToFolder());
  $('download-zip-btn').addEventListener('click', () => void downloadZip());
  $('share-btn').addEventListener('click', shareStats);
  $('convert-another-btn').addEventListener('click', convertAnotherSingle);

  // History
  $('history-btn').addEventListener('click', openHistory);
  $('history-close-btn').addEventListener('click', closeHistory);
  $('history-overlay').addEventListener('click', closeHistory);
  $('history-clear-btn').addEventListener('click', clearHistory);

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
      if (!$('history-panel').classList.contains('hidden')) closeHistory();
      else if (!$('shortcuts-modal').classList.contains('hidden')) showShortcuts(false);
      else if (isConverting) cancelConversion();
    } else if (e.key === 'h' || e.key === 'H') openHistory();
    else if (e.key === 'b' || e.key === 'B') void pickFolder();
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
}

function updateSliderFill(): void {
  const slider = $('quality-slider') as HTMLInputElement;
  const pct = ((Number(slider.value) - 1) / 99) * 100;
  slider.style.background = `linear-gradient(90deg, var(--brand-500) 0%, var(--brand-500) ${pct}%, rgba(148, 163, 184, 0.16) ${pct}%, rgba(148, 163, 184, 0.16) 100%)`;
}

function setMode(next: Mode): void {
  mode = next;
  for (const tab of document.querySelectorAll('.mode-tab')) {
    tab.classList.toggle('active', (tab as HTMLElement).dataset.mode === next);
  }
  $('mode-folder').classList.toggle('hidden', next !== 'folder');
  $('mode-single').classList.toggle('hidden', next !== 'single');
}

function onDragOver(e: DragEvent, zone: HTMLElement): void {
  e.preventDefault();
  zone.classList.add('drag-over');
}

async function onDrop(e: DragEvent): Promise<void> {
  e.preventDefault();
  $('drop-zone').classList.remove('drag-over');
  const files = e.dataTransfer?.files;
  if (!files?.length) return;

  const images = Array.from(files).filter((f) => isSupportedImage(f.name));
  if (images.length > 0) {
    setSelection(
      images.map((file) => ({ file, relativePath: file.name })),
      'Dropped files',
    );
  }
}

async function pickFolder(): Promise<void> {
  if (isConverting) return;
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    await setFolderHandle(handle);
  } catch (err) {
    if ((err as Error).name !== 'AbortError') showToast('Could not open folder', 'error');
  }
}

async function setFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  folderHandle = handle;
  showToast('Scanning folder...', 'info');
  files = await enumerateFiles(handle);
  renderSelection(handle.name);
}

function setSelection(entries: DirEntry[], label: string): void {
  folderHandle = null;
  files = entries;
  renderSelection(label);
}

function renderSelection(label: string): void {
  const badge = $('source-badge');
  const info = $('source-info');
  $('source-path').textContent = label;
  badge.classList.remove('hidden');

  collidedPaths = findCollisions(files.map((f) => f.relativePath));
  const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);
  const skipped = collidedPaths.size;

  if (files.length === 0) {
    info.textContent = 'No supported images found';
    info.classList.add('invalid');
  } else {
    info.textContent =
      `${files.length} image${files.length === 1 ? '' : 's'} · ${formatBytes(totalBytes)}` +
      (skipped > 0 ? ` · ${skipped} skipped (name conflicts)` : '');
    info.classList.remove('invalid');
  }
  ($('convert-btn') as HTMLButtonElement).disabled = files.length === 0 || isConverting;
}

function getOptions() {
  const resizeActive = $('toggle-resize').classList.contains('active');
  const width = ($('resize-width') as HTMLInputElement).valueAsNumber;
  const height = ($('resize-height') as HTMLInputElement).valueAsNumber;
  return {
    quality: Number(($('quality-slider') as HTMLInputElement).value),
    resizeWidth: resizeActive && Number.isFinite(width) ? width : null,
    resizeHeight: resizeActive && Number.isFinite(height) ? height : null,
  };
}

async function startConversion(): Promise<void> {
  if (isConverting || mode !== 'folder' || files.length === 0) return;

  isConverting = true;
  cancelRequested = false;
  results = [];
  elapsedSeconds = 0;
  startedAt = performance.now();

  const options = getOptions();
  const queue = files.filter((f) => !collidedPaths.has(f.relativePath));
  if (queue.length === 0) {
    isConverting = false;
    showToast('All files were skipped due to name conflicts', 'error');
    return;
  }
  showState('running');
  updateProgress(0, files.length);
  showToast(`Converting ${files.length} image${files.length === 1 ? '' : 's'} to WebP...`, 'info');

  elapsedTimer = setInterval(() => {
    elapsedSeconds = (performance.now() - startedAt) / 1000;
    const frac = results.length / files.length;
    const eta = estimateEtaSeconds(elapsedSeconds, frac);
    $('running-elapsed').textContent = `${formatDuration(elapsedSeconds)} elapsed`;
    $('running-eta').textContent = eta === null ? '--' : formatDuration(eta);
  }, 100);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length && !cancelRequested) {
      const entry = queue[next++];
      const result = await convertFile(entry.file, options, entry.relativePath);
      results.push(result);
      updateProgress(results.length, files.length);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  stopTimer();
  const elapsed = (performance.now() - startedAt) / 1000;
  isConverting = false;

  if (cancelRequested) {
    const kept = results.filter((r) => r.success).length;
    if (kept > 0) {
      // Graceful cancellation: keep and offer everything already converted.
      showComplete(elapsed);
      showToast(`Cancelled — ${kept} converted file${kept === 1 ? '' : 's'} kept`, 'warn');
    } else {
      showState('idle');
      showToast('Conversion cancelled', 'warn');
    }
    return;
  }

  const failures = results.filter((r) => !r.success).length;
  if (results.length > 0 && failures === results.length) {
    showState('error');
    $('error-message').textContent = 'No images could be converted.';
    return;
  }
  showComplete(elapsed);
}

function countFailures(): number {
  return results.filter((r) => !r.success).length + collidedPaths.size;
}

function stopTimer(): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function updateProgress(processed: number, total: number): void {
  const fraction = total > 0 ? processed / total : 0;
  $('progress-bar').style.width = `${Math.round(fraction * 100)}%`;
  $('progress-percent').textContent = `${Math.round(fraction * 100)}%`;
  $('running-processed').textContent = String(processed);
  $('running-total').textContent = String(total);
}

function cancelConversion(): void {
  if (!isConverting) return;
  cancelRequested = true;
  const btn = $('cancel-btn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Cancelling...';
  showToast('Finishing in-flight conversions...', 'warn');
}

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

function showComplete(elapsed: number): void {
  showState('complete');

  const successful = results.filter((r) => r.success);
  const originalBytes = successful.reduce((sum, r) => sum + r.originalSize, 0);
  const convertedBytes = successful.reduce((sum, r) => sum + r.convertedSize, 0);
  const saved = Math.max(0, originalBytes - convertedBytes);
  const percent = originalBytes > 0 ? ((saved / originalBytes) * 100).toFixed(1) : '0.0';
  const failedCount = countFailures();

  $('complete-time').textContent = `Finished in ${formatDuration(elapsed)}`;
  $('stat-saved').textContent = formatBytes(saved);
  $('stat-saved-pct').textContent = `${percent}% reduction`;
  $('stat-converted').textContent = `${successful.length} / ${files.length}`;
  $('stat-failed').textContent = failedCount > 0 ? `${failedCount} failed` : 'All successful';
  $('stat-original').textContent = formatBytes(originalBytes);
  $('stat-new').textContent = formatBytes(convertedBytes);

  const collisionsNote = $('collisions-note');
  if (collidedPaths.size > 0) {
    collisionsNote.textContent =
      `${collidedPaths.size} file(s) skipped: multiple inputs map to the same .webp output name.`;
    collisionsNote.classList.remove('hidden');
  } else {
    collisionsNote.classList.add('hidden');
  }

  lastStats = {
    saved: formatBytes(saved),
    percent,
    files: `${successful.length} / ${files.length}`,
    elapsed: formatDuration(elapsed),
    quality: Number(($('quality-slider') as HTMLInputElement).value),
    original: formatBytes(originalBytes),
    webp: formatBytes(convertedBytes),
  };
  pushHistory({
    id: Math.random().toString(36).slice(2, 10),
    name: folderHandle?.name ?? 'Dropped files',
    files: `${successful.length}/${files.length}`,
    saved: formatBytes(saved),
    percent: `${percent}%`,
    elapsed: formatDuration(elapsed),
    timestamp: Date.now(),
  });

  showToast('WebP conversion complete!', 'success');
}

function resetUI(): void {
  showState('idle');
  files = [];
  results = [];
  collidedPaths = new Set();
  folderHandle = null;
  $('progress-bar').style.width = '0%';
  $('source-badge').classList.add('hidden');
  ($('convert-btn') as HTMLButtonElement).disabled = true;
}

/* ------------------------------ Single mode ------------------------------ */

function handleSingleFile(file: File): void {
  if (!file.type.startsWith('image/') && !isSupportedImage(file.name)) {
    showToast('Please select an image file', 'error');
    return;
  }
  $('single-upload').classList.add('hidden');
  $('single-converting').classList.remove('hidden');
  const options = getOptions();

  convertFile(file, options)
    .then((result) => {
      if (!result.success || !result.blob) {
        throw new Error(result.error ?? 'Conversion failed');
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(result.blob);
      ($('single-preview-img') as HTMLImageElement).src = previewUrl;
      const download = $('single-download-btn') as HTMLAnchorElement;
      download.href = previewUrl;
      download.download = result.name;
      const savedPct = Math.max(0, (1 - result.convertedSize / result.originalSize) * 100).toFixed(0);
      $('single-result-info').textContent =
        `${formatBytes(result.originalSize)} → ${formatBytes(result.convertedSize)} (${savedPct}% smaller)`;
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

/* ------------------------------- Downloads ------------------------------- */

async function saveToFolder(): Promise<void> {
  const successful = results.filter((r) => r.success && r.blob);
  if (successful.length === 0) {
    showToast('No converted files to save', 'error');
    return;
  }
  try {
    const outputHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    showToast('Writing files...', 'info');
    let written = 0;
    const failures: string[] = [];
    for (const result of successful) {
      if (!result.blob) continue;
      // Preserve the folder structure of dropped folders; flat selections
      // have single-segment paths.
      const relative = resolveRelativePath(result);
      try {
        await writeFileToDir(outputHandle, relative, result.blob);
        written++;
      } catch {
        failures.push(relative);
      }
    }
    if (failures.length > 0) {
      // Keep every blob in memory so the failed writes can be retried.
      showToast(`Saved ${written} files; failed to write ${failures.length} (you can retry)`, 'warn');
    } else {
      showToast(`Saved ${written} files to ${outputHandle.name}`, 'success');
      releaseBlobs(successful);
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') showToast('Could not write files', 'error');
  }
}

/**
 * Drop encoded blobs from results once they are safely exported — for large
 * batches this can free hundreds of MB while the completion screen is open.
 */
function releaseBlobs(exported: FileResult[]): void {
  for (const result of exported) result.blob = undefined;
  if (results.every((r) => !r.blob)) {
    showToast('In-memory copies released — use Convert More for a new batch', 'info');
  }
}

function resolveRelativePath(result: FileResult): string {
  return result.relativePath;
}

async function downloadZip(): Promise<void> {
  const successful = results.filter((r) => r.success && r.blob);
  if (successful.length === 0) {
    showToast('No converted files to download', 'error');
    return;
  }
  showToast('Creating ZIP...', 'info');
  const zip = new JSZip();
  for (const result of successful) {
    if (!result.blob) continue;
    zip.file(resolveRelativePath(result), result.blob);
  }
  let url: string | null = null;
  try {
    const blob = await zip.generateAsync({ type: 'blob' });
    url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'converted-images.zip';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    showToast(`Downloaded ${successful.length} files as ZIP`, 'success');
    releaseBlobs(successful);
  } catch {
    showToast('Failed to create the ZIP archive (out of memory?)', 'error');
  } finally {
    if (url) {
      // Revoke on a delay — revoking synchronously can abort the download.
      const deadUrl = url;
      setTimeout(() => URL.revokeObjectURL(deadUrl), 10_000);
    }
  }
}

/* -------------------------------- History -------------------------------- */

function pushHistory(entry: HistoryEntry): void {
  const all = readHistory();
  all.unshift(entry);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all.slice(0, HISTORY_LIMIT)));
  } catch {
    // Storage may be unavailable (private mode / quota) — history is optional.
  }
}

function readHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function openHistory(): void {
  renderHistory();
  $('history-panel').classList.remove('hidden');
  $('history-overlay').classList.remove('hidden');
}

function closeHistory(): void {
  $('history-panel').classList.add('hidden');
  $('history-overlay').classList.add('hidden');
}

function renderHistory(): void {
  const list = $('history-list');
  const items = readHistory();
  list.textContent = '';
  $('history-actions').classList.toggle('hidden', items.length === 0);
  if (items.length === 0) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'No conversions yet';
    list.appendChild(note);
    return;
  }
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'history-card';
    card.innerHTML =
      '<div class="meta"><span class="meta-id"></span><span class="meta-date"></span></div>' +
      '<div class="name"></div>' +
      '<div class="stats">' +
      '<div><div class="v"></div><div class="l">Files</div></div>' +
      '<div><div class="v green"></div><div class="l">Saved</div></div>' +
      '<div><div class="v"></div><div class="l">Time</div></div>' +
      '</div>';
    const spans = card.querySelectorAll('span, div.v');
    (spans[0] as HTMLElement).textContent = item.id;
    (spans[1] as HTMLElement).textContent = new Date(item.timestamp).toLocaleDateString();
    const nameEl = card.querySelector('.name') as HTMLElement;
    nameEl.textContent = item.name;
    nameEl.title = item.name;
    (spans[2] as HTMLElement).textContent = item.files;
    (spans[3] as HTMLElement).textContent = item.percent;
    (spans[4] as HTMLElement).textContent = item.elapsed;
    list.appendChild(card);
  }
}

function clearHistory(): void {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
  showToast('History cleared', 'info');
}

function showShortcuts(visible: boolean): void {
  $('shortcuts-modal').classList.toggle('hidden', !visible);
  $('shortcuts-overlay').classList.toggle('hidden', !visible);
}

/* ------------------------------- Share stats ------------------------------ */

function shareStats(): void {
  if (!lastStats) return;
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 320;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  };

  ctx.fillStyle = '#0a0d14';
  roundRect(0, 0, 600, 320, 16);
  ctx.fill();
  ctx.strokeStyle = 'rgba(99,102,241,0.3)';
  ctx.lineWidth = 2;
  roundRect(1, 1, 598, 318, 16);
  ctx.stroke();

  const grad = ctx.createLinearGradient(0, 0, 600, 0);
  grad.addColorStop(0, 'rgba(99,102,241,0.8)');
  grad.addColorStop(1, 'rgba(139,92,246,0.6)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 600, 4);

  ctx.fillStyle = '#f1f5f9';
  ctx.font = 'bold 22px Inter, system-ui, sans-serif';
  ctx.fillText('PicToWebP', 30, 50);
  ctx.fillStyle = '#6b7280';
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.fillText('Bulk image to WebP conversion (in your browser)', 30, 72);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.beginPath();
  ctx.moveTo(30, 90);
  ctx.lineTo(570, 90);
  ctx.stroke();

  const stats = [
    { label: 'SAVED', value: lastStats.saved, sub: `${lastStats.percent} smaller`, color: '#4ade80' },
    { label: 'FILES', value: lastStats.files, sub: 'converted', color: '#818cf8' },
    { label: 'TIME', value: lastStats.elapsed, sub: `@ Q${lastStats.quality}`, color: '#e2e8f0' },
  ];
  stats.forEach((s, i) => {
    const x = 30 + i * 190;
    ctx.fillStyle = '#9ca3af';
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.fillText(s.label, x, 125);
    ctx.fillStyle = s.color;
    ctx.font = 'bold 28px Inter, system-ui, sans-serif';
    ctx.fillText(s.value, x, 162);
    ctx.fillStyle = '#6b7280';
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.fillText(s.sub, x, 182);
  });

  ctx.beginPath();
  ctx.moveTo(30, 205);
  ctx.lineTo(570, 205);
  ctx.stroke();
  ctx.fillStyle = '#1a2030';
  roundRect(30, 225, 540, 16, 4);
  ctx.fill();
  ctx.fillStyle = '#9ca3af';
  ctx.font = '10px Inter, system-ui, sans-serif';
  ctx.fillText(`Original: ${lastStats.original}`, 30, 260);

  const barGrad = ctx.createLinearGradient(30, 0, 570, 0);
  barGrad.addColorStop(0, '#6366f1');
  barGrad.addColorStop(1, '#818cf8');
  ctx.fillStyle = barGrad;
  roundRect(30, 275, 540, 16, 4);
  ctx.fill();
  ctx.fillText(`WebP: ${lastStats.webp}`, 30, 310);

  canvas.toBlob((blob) => {
    if (!blob) {
      showToast('Failed to generate image', 'error');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pictowebp-stats.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    showToast('Stats image downloaded', 'success');
  }, 'image/png');
}

/* --------------------------------- Toasts -------------------------------- */

function showToast(message: string, type: 'info' | 'success' | 'error' | 'warn'): void {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  $('toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
