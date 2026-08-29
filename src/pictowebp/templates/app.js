/**
 * PicToWebP local web UI — application logic.
 * Loaded as an ES module (deferred, DOM-ready) from index.html; all behavior
 * is bound here, no inline event handlers (keeps the CSP strict).
 */
import { createToast, formatBytes } from '/static/ui-core.js';

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
};

let sourceFolder = '';
let folderValid = false;
let isConverting = false;
let evtSource = null;
let lastStats = null;
let previewUrl = null;

const qualitySlider = $('quality');
const qualityValue = $('quality-value');
const convertBtn = $('convert-btn');
const singleFileInput = $('single-file-input');
const dropZone = $('single-drop-zone');

/* ------------------------------ Helpers ------------------------------ */

function updateSliderBg() {
  const pct = ((qualitySlider.value - 1) / 99) * 100;
  qualitySlider.style.background =
    `linear-gradient(90deg, var(--brand-500) 0%, var(--brand-500) ${pct}%, ` +
    `var(--track-tail) ${pct}%, var(--track-tail) 100%)`;
}

function updateConvertButton() {
  convertBtn.disabled = !sourceFolder || isConverting || !folderValid;
}

function setSourceFolder(path) {
  sourceFolder = path;
  const badge = $('source-badge');
  const badgeText = $('source-badge-text');
  // Dynamically created (not present on first load) — must not use $(), which throws.
  const info = document.getElementById('folder-info-badge');
  if (info) info.remove();
  if (path) {
    badge.classList.remove('hidden');
    badgeText.textContent = path;
    badgeText.title = path;
    validateFolder(path);
  } else {
    badge.classList.add('hidden');
    folderValid = false;
    updateConvertButton();
  }
}

function validateFolder(path) {
  fetch('/api/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_folder: path }),
  })
    .then((r) => r.json())
    .then((d) => {
      const badge = $('source-badge');
      const info = document.createElement('span');
      info.id = 'folder-info-badge';
      if (d.valid) {
        info.className = 'badge-info';
        info.textContent = `${d.total_files} images · ${d.total_size_display}`;
        folderValid = true;
      } else {
        info.className = 'badge-info invalid';
        info.textContent = d.error || 'No convertible images found';
        folderValid = false;
      }
      const existing = document.getElementById('folder-info-badge');
      if (existing) existing.remove();
      badge.appendChild(info);
      updateConvertButton();
    })
    .catch(() => {
      folderValid = false;
      updateConvertButton();
    });
}

function showToast(message, type) {
  createToast(message, type);
}

function showState(s) {
  ['idle', 'running', 'complete', 'error'].forEach((id) => {
    $(`progress-${id}`).classList.add('hidden');
  });
  $(`progress-${s}`).classList.remove('hidden');
  if (s === 'running') {
    const btn = $('cancel-btn');
    btn.disabled = false;
    btn.textContent = 'Cancel';
  }
}

function setMode(mode) {
  const tabFolder = $('tab-folder');
  const tabSingle = $('tab-single');
  const modeFolder = $('mode-folder');
  const modeSingle = $('mode-single');
  if (mode === 'folder') {
    tabFolder.className = 'tab active';
    tabSingle.className = 'tab';
    modeFolder.classList.remove('hidden');
    modeSingle.classList.add('hidden');
  } else {
    tabSingle.className = 'tab active';
    tabFolder.className = 'tab';
    modeSingle.classList.remove('hidden');
    modeFolder.classList.add('hidden');
  }
}

/* ------------------------------ Toggles ------------------------------ */

function bindToggle(el, onChange) {
  el.addEventListener('click', () => {
    el.classList.toggle('active');
    el.setAttribute('aria-checked', String(el.classList.contains('active')));
    if (onChange) onChange();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      el.click();
    }
  });
}

function toggleResize() {
  $('resize-inputs').classList.toggle('hidden');
}

/* --------------------------- Single image ---------------------------- */

function handleSingleFile(file) {
  if (!file.type.startsWith('image/')) {
    showToast('Please select an image file', 'error');
    return;
  }
  $('single-upload').classList.add('hidden');
  $('single-converting').classList.remove('hidden');

  const lossless = $('toggle-lossless').classList.contains('active');
  const stripMeta = $('toggle-metadata').classList.contains('active');
  const resizeActive = $('toggle-resize').classList.contains('active');
  const resizeW = resizeActive ? $('resize_width').value || null : null;
  const resizeH = resizeActive ? $('resize_height').value || null : null;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('quality', Number(qualitySlider.value));
  formData.append('lossless', lossless);
  formData.append('strip_metadata', stripMeta);
  if (resizeW) formData.append('resize_width', resizeW);
  if (resizeH) formData.append('resize_height', resizeH);

  fetch('/api/convert-single', { method: 'POST', body: formData })
    .then((resp) => {
      if (!resp.ok)
        return resp.json().then((d) => {
          throw new Error(d.detail || 'Conversion failed');
        });
      const blobPromise = resp.blob();
      const disposition = resp.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?(.+?)"?$/);
      const filename = match
        ? match[1]
        : file.name.replace(/\.[^.]+$/, '') + '.webp';
      return blobPromise.then((b) => ({ blob: b, filename }));
    })
    .then((result) => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(result.blob);
      $('single-preview-img').src = previewUrl;
      const download = $('single-download-btn');
      download.href = previewUrl;
      download.download = result.filename;
      const origSize = (file.size / 1024).toFixed(1);
      const newSize = (result.blob.size / 1024).toFixed(1);
      const saved = Math.max(0, (1 - result.blob.size / file.size) * 100).toFixed(0);
      $('single-result-info').textContent = `${origSize} KB → ${newSize} KB (${saved}% smaller)`;
      $('single-converting').classList.add('hidden');
      $('single-result').classList.remove('hidden');
    })
    .catch((err) => {
      $('single-converting').classList.add('hidden');
      $('single-upload').classList.remove('hidden');
      showToast(err.message || 'Conversion failed', 'error');
    });
}

function convertAnotherSingle() {
  $('single-result').classList.add('hidden');
  $('single-upload').classList.remove('hidden');
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  $('single-preview-img').src = '';
  singleFileInput.value = '';
}

/* ----------------------------- Conversion ---------------------------- */

function startConversion() {
  if (isConverting || !sourceFolder) return;
  isConverting = true;
  updateConvertButton();
  showState('running');
  showToast('Converting to WebP...', 'info');

  const resizeActive = $('toggle-resize').classList.contains('active');
  const payload = {
    source_folder: sourceFolder,
    quality: Number(qualitySlider.value),
    lossless: $('toggle-lossless').classList.contains('active'),
    strip_metadata: $('toggle-metadata').classList.contains('active'),
    resize_width: resizeActive && $('resize_width').value ? Number($('resize_width').value) : null,
    resize_height: resizeActive && $('resize_height').value ? Number($('resize_height').value) : null,
  };

  fetch('/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((r) => {
      if (!r.ok) return r.json().then((b) => { throw new Error(b.detail || 'Failed'); });
      startSSE();
    })
    .catch((e) => {
      isConverting = false;
      updateConvertButton();
      showState('error');
      $('error-message').textContent = e.message;
      showToast(e.message, 'error');
    });
}

function startSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource('/progress');
  evtSource.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.status === 'running') {
      const frac = Number(d.fraction_complete);
      const elapsed = Number(d.elapsed_seconds);
      $('progress-bar').style.width = `${frac * 100}%`;
      $('progress-percent').textContent = `${(frac * 100).toFixed(0)}%`;
      $('running-processed').textContent = d.processed_files;
      $('running-total').textContent = d.total_files;
      $('running-elapsed').textContent = `${elapsed.toFixed(1)}s elapsed`;
      $('running-eta').textContent =
        frac > 0 && frac < 1 ? `${((elapsed * (1 - frac)) / frac).toFixed(0)}s` : '--';
    } else if (d.status === 'completed') {
      isConverting = false;
      convertBtn.disabled = true;
      showState('complete');
      $('complete-time').textContent = `Finished in ${Number(d.elapsed_seconds).toFixed(1)}s`;
      $('stat-saved').textContent = formatBytes(d.bytes_saved);
      $('stat-saved-percent').textContent = `${Number(d.reduction_percent).toFixed(1)}% reduction`;
      $('stat-converted').textContent = `${d.converted_files} / ${d.total_files}`;
      $('stat-failed').textContent = d.failed_files > 0 ? `${d.failed_files} failed` : 'All successful';
      $('stat-original').textContent = formatBytes(d.original_bytes);
      $('stat-new').textContent = formatBytes(d.converted_bytes);
      lastStats = {
        files: `${d.converted_files} / ${d.total_files}`,
        saved: formatBytes(d.bytes_saved),
        percent: `${Number(d.reduction_percent).toFixed(1)}%`,
        original: formatBytes(d.original_bytes),
        webp: formatBytes(d.converted_bytes),
        elapsed: `${Number(d.elapsed_seconds).toFixed(1)}s`,
        quality: qualitySlider.value,
      };
      if (d.output_folder) {
        $('stat-output-folder').classList.remove('hidden');
        $('stat-output-path').textContent = d.output_folder;
        $('open-folder-btn').classList.remove('hidden');
        $('download-zip-btn').classList.remove('hidden');
      } else {
        $('stat-output-folder').classList.add('hidden');
        $('open-folder-btn').classList.add('hidden');
        $('download-zip-btn').classList.add('hidden');
      }
      $('share-btn').classList.remove('hidden');
      showToast('WebP conversion complete!', 'success');
      if (evtSource) {
        evtSource.close();
        evtSource = null;
      }
    } else if (d.status === 'failed' || d.status === 'cancelled') {
      isConverting = false;
      convertBtn.disabled = true;
      showState('error');
      $('error-message').textContent = d.error || `Conversion ${d.status}`;
      showToast(`Conversion ${d.status}`, 'error');
      if (evtSource) {
        evtSource.close();
        evtSource = null;
      }
    }
  };
}

function cancelConversion() {
  const btn = $('cancel-btn');
  btn.disabled = true;
  btn.textContent = 'Cancelling...';
  fetch('/convert/cancel', { method: 'POST' })
    .then(() => showToast('Cancelling...', 'warn'))
    .catch(() => showToast('Failed to cancel', 'error'));
}

function resetUI() {
  showState('idle');
  $('progress-bar').style.width = '0%';
  $('open-folder-btn').classList.add('hidden');
  $('share-btn').classList.add('hidden');
  $('download-zip-btn').classList.add('hidden');
  $('stat-output-folder').classList.add('hidden');
  setSourceFolder('');
  isConverting = false;
  updateConvertButton();
  // Close any lingering SSE connection from the previous conversion.
  if (evtSource) {
    evtSource.close();
    evtSource = null;
  }
  // Reset single image mode.
  setMode('folder');
  $('single-upload').classList.remove('hidden');
  $('single-converting').classList.add('hidden');
  $('single-result').classList.add('hidden');
  singleFileInput.value = '';
}

function openOutputFolder() {
  const path = $('stat-output-path').textContent;
  if (!path) {
    showToast('No output folder path', 'error');
    return;
  }
  fetch('/api/open-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_folder: path }),
  })
    .then((r) => {
      if (!r.ok) return r.json().then((b) => { throw new Error(b.detail || 'Failed'); });
      showToast('Folder opened', 'success');
    })
    .catch((e) => showToast(`Could not open folder: ${e.message || 'Unknown error'}`, 'error'));
}

function downloadZip() {
  if (!lastStats) {
    showToast('Nothing to download yet', 'error');
    return;
  }
  showToast('Preparing ZIP...', 'info');
  fetch('/api/download-zip')
    .then((r) => {
      if (!r.ok) return r.json().then((b) => { throw new Error(b.detail || 'Failed'); });
      return r.blob();
    })
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'converted-images.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      showToast('ZIP downloaded', 'success');
    })
    .catch((e) => showToast(e.message || 'Failed to create ZIP', 'error'));
}

/* ---------------------------- Share stats ---------------------------- */

function shareStats() {
  if (!lastStats) return;
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 320;
  const ctx = canvas.getContext('2d');

  const roundedRect = (x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  };

  ctx.fillStyle = '#0a0d14';
  roundedRect(0, 0, 600, 320, 16);
  ctx.fill();

  ctx.strokeStyle = 'rgba(99,102,241,0.3)';
  ctx.lineWidth = 2;
  roundedRect(1, 1, 598, 318, 16);
  ctx.stroke();

  const grad = ctx.createLinearGradient(0, 0, 600, 0);
  grad.addColorStop(0, 'rgba(99,102,241,0.8)');
  grad.addColorStop(1, 'rgba(139,92,246,0.6)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 600, 4);

  ctx.fillStyle = '#f1f5f9';
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.fillText('PicToWebP', 30, 50);

  ctx.fillStyle = '#6b7280';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText('Bulk image to WebP conversion', 30, 72);

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
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
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillText(s.label, x, 125);
    ctx.fillStyle = s.color;
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.fillText(s.value, x, 162);
    ctx.fillStyle = '#6b7280';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(s.sub, x, 182);
  });

  ctx.beginPath();
  ctx.moveTo(30, 205);
  ctx.lineTo(570, 205);
  ctx.stroke();

  const origBytes = parseFloat(lastStats.original);
  const webpBytes = parseFloat(lastStats.webp);
  const maxBar = 540;
  const origW = maxBar;
  const webpW = origBytes > 0 ? Math.max((webpBytes / origBytes) * maxBar, 20) : maxBar;

  ctx.fillStyle = '#1a2030';
  roundedRect(30, 225, origW, 16, 4);
  ctx.fill();
  ctx.fillStyle = '#9ca3af';
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText(`Original: ${lastStats.original}`, 30, 260);

  const barGrad = ctx.createLinearGradient(30, 0, 30 + webpW, 0);
  barGrad.addColorStop(0, '#6366f1');
  barGrad.addColorStop(1, '#818cf8');
  ctx.fillStyle = barGrad;
  roundedRect(30, 275, webpW, 16, 4);
  ctx.fill();
  ctx.fillText(`WebP: ${lastStats.webp}`, 30, 310);

  canvas.toBlob((blob) => {
    if (!blob) {
      showToast('Failed to generate image', 'error');
      return;
    }
    const url = URL.createObjectURL(blob);
    if (navigator.share && navigator.canShare) {
      const file = new File([blob], 'pictowebp-stats.png', { type: 'image/png' });
      const shareData = {
        title: 'PicToWebP Stats',
        text: `I just converted images to WebP and saved ${lastStats.percent}!`,
        files: [file],
      };
      if (navigator.canShare(shareData)) {
        navigator.share(shareData).catch(() => {});
        URL.revokeObjectURL(url);
        return;
      }
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pictowebp-stats.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Stats image downloaded', 'success');
  }, 'image/png');
}

/* --------------------------- Browse modal ---------------------------- */

let browseSelected = '';
let browseCurrentPath = '';

function openBrowser() {
  if (isConverting) return;
  $('browse-modal').classList.remove('hidden');
  browseSelected = '';
  $('browse-selected').textContent = '';
  $('browse-select-btn').disabled = true;
  browseTo(sourceFolder || '');
}

function closeBrowser() {
  $('browse-modal').classList.add('hidden');
}

function browseTo(path) {
  fetch('/api/browse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_folder: path }),
  })
    .then((r) => r.json())
    .then((d) => {
      $('browse-current').textContent = d.current;
      browseCurrentPath = d.current;

      const list = $('browse-list');
      list.innerHTML = '';

      // Drives
      if (d.drives && d.drives.length) {
        d.drives.forEach((drive) => {
          const btn = document.createElement('button');
          btn.className = 'browse-item';
          btn.dataset.path = drive;
          btn.innerHTML =
            '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg><span></span>';
          btn.querySelector('span').textContent = drive;
          btn.addEventListener('click', () => browseTo(drive));
          list.appendChild(btn);
        });
      }

      // Parent
      if (d.parent) {
        const btn = document.createElement('button');
        btn.className = 'browse-item';
        btn.dataset.path = d.parent;
        btn.innerHTML =
          '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7"/></svg><span>..</span>';
        btn.addEventListener('click', () => browseTo(d.parent));
        list.appendChild(btn);
      }

      // Entries
      d.entries.forEach((entry) => {
        const btn = document.createElement('button');
        btn.className = 'browse-item';
        btn.dataset.path = entry.path;
        btn.innerHTML =
          '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg><span></span>';
        btn.querySelector('span').textContent = entry.name;
        btn.addEventListener('click', () => browseTo(entry.path));
        list.appendChild(btn);
      });

      if (!d.drives && !d.parent && !d.entries.length) {
        const p = document.createElement('p');
        p.className = 'empty-note';
        p.textContent = 'No subdirectories';
        list.appendChild(p);
      }

      // Auto-select current directory if it's not "This PC".
      if (d.current !== 'This PC') {
        browseSelected = d.current;
        $('browse-selected').textContent = d.current;
        $('browse-select-btn').disabled = false;
      } else {
        browseSelected = '';
        $('browse-selected').textContent = 'Navigate to a folder';
        $('browse-select-btn').disabled = true;
      }

      // Up button
      $('browse-up-btn').onclick = () => {
        if (browseCurrentPath === 'This PC') return;
        const parent = browseCurrentPath.replace(/[/\\][^/\\]+$/, '');
        if (parent !== browseCurrentPath) browseTo(parent);
        else browseTo('');
      };
    })
    .catch(() => {
      const list = $('browse-list');
      list.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = 'Failed to load';
      list.appendChild(p);
    });
}

/* ------------------------------ History ------------------------------ */

function showHistoryPanel() {
  $('history-panel').classList.remove('hidden');
  fetch('/api/history')
    .then((r) => r.json())
    .then((d) => renderHistory(d.history))
    .catch(() => {
      const list = $('history-list');
      list.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = 'Failed to load';
      list.appendChild(p);
    });
}

function hideHistoryPanel() {
  $('history-panel').classList.add('hidden');
}

function renderHistory(items) {
  const list = $('history-list');
  const act = $('history-actions');
  if (!items || !items.length) {
    list.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'No conversions yet';
    list.appendChild(p);
    act.classList.add('hidden');
    return;
  }
  act.classList.remove('hidden');
  list.innerHTML = '';
  items
    .slice()
    .reverse()
    .forEach((h) => {
      const folder = h.source_folder.split(/[/\\]/).pop() || h.source_folder;
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
      // Fill dynamic values via textContent (never innerHTML) so odd
      // folder names cannot inject markup.
      const spans = card.querySelectorAll('span, .name, .v');
      spans[0].textContent = h.id;
      spans[1].textContent = new Date(h.timestamp).toLocaleDateString();
      const folderDiv = spans[2];
      folderDiv.textContent = folder;
      folderDiv.title = h.source_folder;
      spans[3].textContent = `${h.converted_files}/${h.total_files}`;
      spans[4].textContent = `${Number(h.reduction_percent).toFixed(1)}%`;
      spans[5].textContent = `${Number(h.elapsed_seconds).toFixed(1)}s`;
      list.appendChild(card);
    });
}

function clearHistory() {
  fetch('/api/history', { method: 'DELETE' }).then(() => {
    const list = $('history-list');
    list.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'No conversions yet';
    list.appendChild(p);
    $('history-actions').classList.add('hidden');
    showToast('Cleared', 'info');
  });
}

/* --------------------------- Drag overlay ---------------------------- */

let dragDepth = 0;

function hideDragOverlay() {
  dragDepth = 0;
  $('drag-overlay').classList.add('hidden');
}

function wireDragOverlay() {
  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    $('drag-overlay').classList.remove('hidden');
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
    // The server can only accept uploaded files one at a time, so a drop
    // always routes to single-image mode.
    setMode('single');
    handleSingleFile(files[0]);
  });
}

/* -------------------------------- Init ------------------------------- */

function initUI() {
  qualitySlider.addEventListener('input', () => {
    qualityValue.textContent = qualitySlider.value;
    qualitySlider.setAttribute('aria-valuetext', `${qualitySlider.value} out of 100`);
    updateSliderBg();
  });
  updateSliderBg();

  document.querySelectorAll('.chip[data-preset]').forEach((chip) => {
    chip.addEventListener('click', () => {
      qualitySlider.value = chip.dataset.preset;
      qualityValue.textContent = chip.dataset.preset;
      updateSliderBg();
    });
  });

  bindToggle($('toggle-lossless'));
  bindToggle($('toggle-metadata'));
  bindToggle($('toggle-resize'), toggleResize);

  $('tab-folder').addEventListener('click', () => setMode('folder'));
  $('tab-single').addEventListener('click', () => setMode('single'));

  // Folder mode
  $('pick-folder-btn').addEventListener('click', openBrowser);
  $('convert-btn').addEventListener('click', startConversion);
  $('cancel-btn').addEventListener('click', cancelConversion);
  $('open-folder-btn').addEventListener('click', openOutputFolder);
  $('download-zip-btn').addEventListener('click', downloadZip);
  $('share-btn').addEventListener('click', shareStats);
  $('convert-more-btn').addEventListener('click', resetUI);
  $('try-again-btn').addEventListener('click', resetUI);

  // Single mode
  dropZone.addEventListener('click', () => singleFileInput.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drag-over');
    hideDragOverlay();
    if (e.dataTransfer.files.length > 0) handleSingleFile(e.dataTransfer.files[0]);
  });
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      singleFileInput.click();
    }
  });
  singleFileInput.addEventListener('change', () => {
    if (singleFileInput.files.length > 0) handleSingleFile(singleFileInput.files[0]);
  });
  $('convert-another-btn').addEventListener('click', convertAnotherSingle);

  // History
  $('history-btn').addEventListener('click', showHistoryPanel);
  $('history-close-btn').addEventListener('click', hideHistoryPanel);
  $('history-clear-btn').addEventListener('click', clearHistory);

  // Browse modal
  $('browse-up-btn').addEventListener('click', () => {
    if (browseCurrentPath === 'This PC') return;
    const parent = browseCurrentPath.replace(/[/\\][^/\\]+$/, '');
    if (parent !== browseCurrentPath) browseTo(parent);
    else browseTo('');
  });
  $('browse-select-btn').addEventListener('click', () => {
    if (browseSelected) setSourceFolder(browseSelected);
    closeBrowser();
  });
  $('browse-close-btn').addEventListener('click', closeBrowser);
  $('browse-cancel-btn').addEventListener('click', closeBrowser);
  document.querySelector('#browse-modal .absolute-inset').addEventListener('click', closeBrowser);

  // Shortcuts modal
  $('shortcuts-btn').addEventListener('click', () => $('shortcuts-modal').classList.remove('hidden'));
  $('shortcuts-close-btn').addEventListener('click', () => $('shortcuts-modal').classList.add('hidden'));
  document
    .querySelector('#shortcuts-modal .absolute-inset')
    .addEventListener('click', () => $('shortcuts-modal').classList.add('hidden'));
  document
    .querySelector('#history-panel .absolute-inset')
    .addEventListener('click', hideHistoryPanel);

  wireDragOverlay();

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Enter' && !isConverting && sourceFolder) {
      e.preventDefault();
      startConversion();
    } else if (e.key === 'Escape') {
      if (!$('browse-modal').classList.contains('hidden')) closeBrowser();
      else if (!$('shortcuts-modal').classList.contains('hidden'))
        $('shortcuts-modal').classList.add('hidden');
      else if (!$('history-panel').classList.contains('hidden')) hideHistoryPanel();
      else if (isConverting) cancelConversion();
    } else if (e.key === 'h' || e.key === 'H') showHistoryPanel();
    else if (e.key === 'b' || e.key === 'B') openBrowser();
    else if (e.key === '?') $('shortcuts-modal').classList.remove('hidden');
  });
}

initUI();
