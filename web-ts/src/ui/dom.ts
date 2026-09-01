/** Small DOM helpers shared across the UI and backends. */

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

/** Trigger a browser download for an in-memory blob and free its URL. */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoke on a delay — revoking synchronously can abort the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}