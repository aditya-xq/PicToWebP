import { $ } from './dom';

/** Append a toast notification to #toast-container (auto-removes itself). */
export function showToast(message: string, type: 'info' | 'success' | 'error' | 'warn'): void {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  $('toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}