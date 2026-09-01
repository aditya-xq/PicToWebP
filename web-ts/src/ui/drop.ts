import { isSupportedImage } from '../core';
import type { DirEntry } from '../converter';

/** True when a drag event carries files/folders. */
export const hasFiles = (e: DragEvent): boolean =>
  Array.from(e.dataTransfer?.types ?? []).includes('Files');

/**
 * Walk dropped items via their filesystem entries so dropped *folders* work
 * too, matching the CLIs' recursive behavior. `webkitGetAsEntry()` must be
 * read synchronously — item lists are invalidated once the handler yields.
 */
export async function entriesFromDrop(items: DataTransferItemList, files: FileList): Promise<DirEntry[]> {
  const dropEntries = Array.from(items)
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (dropEntries.length === 0) {
    return Array.from(files)
      .filter((f) => isSupportedImage(f.name))
      .map((file) => ({ file, relativePath: file.name }));
  }

  const collected: DirEntry[] = [];
  for (const entry of dropEntries) {
    collected.push(...(await walkEntry(entry, '')));
  }
  return collected;
}

export async function walkEntry(
  entry: FileSystemEntry,
  base: string,
  depth: number = 32,
): Promise<DirEntry[]> {
  const path = base ? `${base}/${entry.name}` : entry.name;
  if (entry.isFile) {
    if (!isSupportedImage(entry.name)) return [];
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    return [{ file, relativePath: path }];
  }
  if (entry.isDirectory && !entry.name.startsWith('.') && depth > 0) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const out: DirEntry[] = [];
    // readEntries returns at most ~100 entries per call — loop until empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) {
        out.push(...(await walkEntry(child, path, depth - 1)));
      }
    }
    return out;
  }
  return [];
}