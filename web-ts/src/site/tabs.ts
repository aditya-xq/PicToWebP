export interface TabsOptions {
  /** Panel to open initially; defaults to the first tab. */
  initial?: string;
}

export interface TabsHandle {
  activate(id: string): void;
}

/**
 * Wires a `role="tablist"` element: click, ArrowLeft/ArrowRight/Home/End,
 * roving tabindex and panel visibility. Panels are matched through
 * `aria-controls`, so no id convention is hard-coded here.
 */
export function wireTabs(tablist: HTMLElement, options: TabsOptions = {}): TabsHandle {
  const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  if (tabs.length === 0) return { activate: () => undefined };

  const panels = new Map<string, HTMLElement>();
  for (const tab of tabs) {
    const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
    if (panel) panels.set(tab.id, panel);
  }

  const activate = (id: string): void => {
    const target = tabs.find((tab) => tab.id === id) ?? tabs[0];
    for (const tab of tabs) {
      const selected = tab === target;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle('active', selected);
      panels.get(tab.id)?.toggleAttribute('hidden', !selected);
    }
  };

  const step = (from: number, delta: number): void => {
    const next = tabs[(from + delta + tabs.length) % tabs.length];
    next.focus();
    activate(next.id);
  };

  tablist.addEventListener('click', (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]');
    if (tab && tabs.includes(tab)) activate(tab.id);
  });

  tablist.addEventListener('keydown', (event) => {
    const from = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (from === -1) return;

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      step(from, 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(from, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      tabs[0].focus();
      activate(tabs[0].id);
    } else if (event.key === 'End') {
      const last = tabs[tabs.length - 1];
      event.preventDefault();
      last.focus();
      activate(last.id);
    }
  });

  activate(options.initial ?? tabs[0].id);
  return { activate };
}
