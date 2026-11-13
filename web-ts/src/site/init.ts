import type { BackendCapabilities } from '../backend/types';
import { showToast } from '../ui/toasts';
import { wireCopyButtons } from '../ui/copy';
import { defaultTab, tabButtonId } from './platform';
import { wireTabs } from './tabs';

/**
 * Mounts the always-on page sections: install tabs, copy buttons, the edition
 * highlight and the capability notes.
 *
 * Deliberately independent of `initUI()`, which only runs when the conversion
 * backend probes successfully. A visitor whose browser cannot encode WebP
 * still needs the instructions for running the CLI.
 */
export function initSiteSections(cap: BackendCapabilities): void {
  const main = document.querySelector<HTMLElement>('.main');
  if (!main) return;

  for (const tablist of main.querySelectorAll<HTMLElement>('[role="tablist"]')) {
    wireTabs(tablist, {
      initial: tablist.id === 'install-tabs' ? tabButtonId(defaultTab(navigator)) : undefined,
    });
  }

  wireCopyButtons(main, (message, type = 'success') => showToast(message, type));

  // Highlight the card for the edition actually running, and show only the
  // limitations this backend really has.
  for (const card of main.querySelectorAll<HTMLElement>('[data-edition]')) {
    const current = card.dataset.edition === cap.kind;
    card.classList.toggle('is-current', current);
    card.querySelector<HTMLElement>('[data-current-badge]')?.toggleAttribute('hidden', !current);
  }

  for (const note of main.querySelectorAll<HTMLElement>('[data-when]')) {
    const supported = note.dataset.when === 'metadata' ? cap.metadataControl : cap.lossless;
    note.hidden = supported;
  }
}
