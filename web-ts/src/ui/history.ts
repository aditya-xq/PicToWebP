import type { ConversionBackend, HistoryEntry } from '../backend';
import { $ } from './dom';
import { showToast } from './toasts';

/** Render the history list (empty state included). */
export function renderHistory(items: HistoryEntry[]): void {
  const list = $('history-list');
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

export async function openHistory(backend: ConversionBackend): Promise<void> {
  renderHistory([]);
  $('history-panel').classList.remove('hidden');
  $('history-overlay').classList.remove('hidden');
  try {
    renderHistory(await backend.getHistory());
  } catch {
    const list = $('history-list');
    list.textContent = '';
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'Failed to load';
    list.appendChild(p);
  }
}

export function closeHistory(): void {
  $('history-panel').classList.add('hidden');
  $('history-overlay').classList.add('hidden');
}

export async function clearHistory(backend: ConversionBackend): Promise<void> {
  await backend.clearHistory();
  renderHistory([]);
  showToast('History cleared', 'info');
}