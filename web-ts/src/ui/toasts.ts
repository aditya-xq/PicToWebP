import { $ } from './dom';

const TOAST_MS = 5000;

/** Append a toast notification to #toast-container (auto-removes itself). */
export function showToast(message: string, type: 'info' | 'success' | 'error' | 'warn'): void {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;

  const dismiss = document.createElement('button');
  dismiss.className = 'toast-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss notification');
  dismiss.textContent = '✕';

  let timer: ReturnType<typeof setTimeout> | undefined;
  const remove = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    toast.remove();
  };
  dismiss.addEventListener('click', remove);

  toast.append(text, dismiss);
  $('toast-container').appendChild(toast);
  timer = setTimeout(remove, TOAST_MS);
}