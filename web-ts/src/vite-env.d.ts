/// <reference types="vite/client" />

interface FileSystemDirectoryHandle extends FileSystemHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>;
}

interface FileSystemFileHandle extends FileSystemHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: FileSystemWriteChunkType): Promise<void>;
  close(): Promise<void>;
}

type FileSystemWriteChunkType = BufferSource | Blob | string | DataView;

interface Window {
  showDirectoryPicker(options?: {
    mode?: 'read' | 'readwrite';
    startIn?: FileSystemHandle;
  }): Promise<FileSystemDirectoryHandle>;
}

interface WebKitFileSystemEntry extends FileSystemEntry {
  webkitGetAsEntry?: () => FileSystemEntry | null;
  directoryHandle?: FileSystemDirectoryHandle;
}
