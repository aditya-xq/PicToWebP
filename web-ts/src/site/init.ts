import { showToast } from '../ui/toasts';
import { wireCopyButtons } from '../ui/copy';
import { defaultTab, tabButtonId } from './platform';
import { wireTabs } from './tabs';

/**
 * Mounts the always-on page sections: the install tabs and every copy button.
 *
 * Deliberately independent of `initUI()`, which only runs when the conversion
 * backend probes successfully. A visitor whose browser cannot encode WebP
 * still needs the instructions for running the CLI.
 */
export function initSiteSections(): void {
  const main = document.querySelector<HTMLElement>('.main');
  if (!main) return;

  for (const tablist of main.querySelectorAll<HTMLElement>('[role="tablist"]')) {
    wireTabs(tablist, {
      initial: tablist.id === 'install-tabs' ? tabButtonId(defaultTab(navigator)) : undefined,
    });
  }

  wireCopyButtons(main, (message, type = 'success') => showToast(message, type));
}
