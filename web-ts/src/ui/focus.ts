/** Lightweight focus trapping for modals and drawers. */

const handlers = new WeakMap<HTMLElement, (e: KeyboardEvent) => void>();
const previouslyFocused = new WeakMap<HTMLElement, HTMLElement | null>();

function focusablesIn(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null || el === container);
}

/**
 * Trap Tab/Shift+Tab navigation inside `container` while enabled, and restore
 * focus to the previously-focused element when disabled. Install at most one
 * handler per container; passing `false` (or `true` twice) is a no-op unless
 * the state actually changes.
 */
export function setFocusTrap(container: HTMLElement, enabled: boolean): void {
  const active = handlers.has(container);
  if (enabled === active) return;

  if (!enabled) {
    handlers.delete(container);
    const previous = previouslyFocused.get(container);
    previouslyFocused.delete(container);
    if (previous && previous.isConnected) previous.focus();
    return;
  }

  previouslyFocused.set(
    container,
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const focusables = focusablesIn(container);
    if (focusables.length === 0) {
      e.preventDefault();
      container.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const activeEl = document.activeElement;
    if (e.shiftKey) {
      if (activeEl === first || !container.contains(activeEl)) {
        e.preventDefault();
        last.focus();
      }
    } else if (activeEl === last || !container.contains(activeEl)) {
      e.preventDefault();
      first.focus();
    }
  };

  document.addEventListener('keydown', onKey, true);
  handlers.set(container, onKey);
}