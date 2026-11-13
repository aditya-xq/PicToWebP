export type CopyNotify = (message: string, type?: 'info' | 'success' | 'error' | 'warn') => void;

const COPIED_MS = 2000;

/**
 * Wires every `[data-copy]` button to the element whose id it names: copies the
 * text, flips the label to "Copied" for two seconds, and reports through
 * `notify`.
 *
 * Falls back to selecting the text when the clipboard API is missing or
 * rejects. It is available in both profiles (Pages is HTTPS, `pictowebp-web`
 * serves localhost), so the fallback is for denied permissions rather than the
 * normal path.
 */
export function wireCopyButtons(root: ParentNode, notify: CopyNotify): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    button.addEventListener('click', () => {
      void copy(button, notify);
    });
  }
}

async function copy(button: HTMLButtonElement, notify: CopyNotify): Promise<void> {
  const source = document.getElementById(button.dataset.copy ?? '');
  const text = source?.textContent?.trim();
  if (!source || !text) return;

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    select(source);
    notify('Press Ctrl+C to copy', 'warn');
    return;
  }

  const label = button.dataset.label ?? button.textContent ?? 'Copy';
  button.dataset.label = label;
  button.textContent = 'Copied';
  button.classList.add('is-copied');
  window.setTimeout(() => {
    button.textContent = label;
    button.classList.remove('is-copied');
  }, COPIED_MS);
}

function select(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
