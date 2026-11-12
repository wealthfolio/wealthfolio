// File Dialogs
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  BaseDirectory,
  type FileHandle,
  open as openFile,
  startAccessingSecurityScopedResource,
  stopAccessingSecurityScopedResource,
} from "@tauri-apps/plugin-fs";

import { invoke } from "./core";

interface PendingExport {
  relativePath: string;
  filename: string;
}

interface StagedRestore {
  relativePath: string;
  pendingDir: string;
}

const COPY_BUFFER_SIZE = 1024 * 1024;

const isMobileUserAgent = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  const userAgent = window.navigator.userAgent.toLowerCase();
  return /android|iphone|ipad|ipod/.test(userAgent);
};

const isMobileRuntime = async (): Promise<boolean> => {
  try {
    const platform = await invoke<{ is_mobile?: boolean; os: string }>("get_platform");
    return platform.is_mobile ?? (platform.os === "ios" || platform.os === "android");
  } catch {
    return isMobileUserAgent();
  }
};

const fileExtension = (fileName: string): string | null => {
  const extension = fileName.split(".").pop();
  return extension && extension !== fileName ? extension : null;
};

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
};

const restoreId = (): string => {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
};

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const writeAll = async (file: FileHandle, data: Uint8Array): Promise<void> => {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = await file.write(data.subarray(offset));
    if (written <= 0) {
      throw new Error("write returned without writing data");
    }
    offset += written;
  }
};

const copyFileByHandle = async (
  fromPath: string,
  toPath: string,
  options: {
    fromPathBaseDir?: BaseDirectory;
    toPathBaseDir?: BaseDirectory;
    maxBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<void> => {
  let source: FileHandle | null = null;
  let destination: FileHandle | null = null;
  const sourceOptions = {
    read: true,
    ...(options.fromPathBaseDir ? { baseDir: options.fromPathBaseDir } : {}),
  };
  const destinationOptions = {
    write: true,
    create: true,
    truncate: true,
    ...(options.toPathBaseDir ? { baseDir: options.toPathBaseDir } : {}),
  };

  try {
    if (!options.fromPathBaseDir) source = await openFile(fromPath, sourceOptions);
    if (source && options.maxBytes !== undefined && (await source.stat()).size > options.maxBytes) {
      throw new Error("Backup exceeds the supported 2 GiB limit");
    }
    if (!options.toPathBaseDir) destination = await openFile(toPath, destinationOptions);

    const buffer = new Uint8Array(COPY_BUFFER_SIZE);
    let copied = 0;
    while (true) {
      options.signal?.throwIfAborted();
      let bytesRead: number | null;
      if (source) bytesRead = await source.read(buffer);
      else {
        const encoded = await invoke<string>("profile_transfer_file", {
          relativePath: fromPath,
          operation: "read",
          offset: copied,
        });
        const chunk = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
        bytesRead = chunk.length;
        buffer.set(chunk);
      }
      if (bytesRead === null || bytesRead === 0) {
        break;
      }
      copied += bytesRead;
      if (options.maxBytes !== undefined && copied > options.maxBytes) {
        throw new Error("Backup exceeds the supported 2 GiB limit");
      }
      if (destination) await writeAll(destination, buffer.subarray(0, bytesRead));
      else
        await invoke("profile_transfer_file", {
          relativePath: toPath,
          operation: "write",
          offset: copied - bytesRead,
          content: toBase64(buffer.subarray(0, bytesRead)),
        });
    }
  } finally {
    await destination?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
  }
};

export const openCsvFileDialog = async (): Promise<null | string | string[]> => {
  return open({ filters: [{ name: "CSV", extensions: ["csv"] }] });
};

export const openFolderDialog = async (): Promise<string | null> => {
  return open({ directory: true });
};

export const openDatabaseFileDialog = async (): Promise<string | null> => {
  const result = (await open()) as string | string[] | null;
  if (Array.isArray(result)) {
    return result[0] ?? null;
  }
  return typeof result === "string" ? result : null;
};

export const openFileSaveDialog = async (
  fileContent: string | Blob | Uint8Array,
  fileName: string,
): Promise<boolean> => {
  if (typeof fileContent === "string") {
    if (await isMobileRuntime()) {
      const { relativePath, filename } = await invoke<PendingExport>(
        "write_pending_export_text_file",
        {
          fileName,
          content: fileContent,
        },
      );
      return saveAppDataFileViaPicker(relativePath, filename);
    }

    return invoke<boolean>("save_text_file_with_dialog", {
      fileName,
      content: fileContent,
    });
  }

  let contentToSave: Uint8Array;
  if (fileContent instanceof Blob) {
    const arrayBuffer = await fileContent.arrayBuffer();
    contentToSave = new Uint8Array(arrayBuffer);
  } else {
    contentToSave = fileContent;
  }

  const contentBase64 = toBase64(contentToSave);
  if (await isMobileRuntime()) {
    const { relativePath, filename } = await invoke<PendingExport>("write_pending_export_file", {
      fileName,
      contentBase64,
    });
    return saveAppDataFileViaPicker(relativePath, filename);
  }

  return invoke<boolean>("save_file_with_dialog", {
    fileName,
    contentBase64,
  });
};

export const saveAppDataFileViaPicker = async (
  relativePath: string,
  fileName: string,
): Promise<boolean> => {
  if (!/^pending-exports\/[^/\\]+\/[^/\\]+$/.test(relativePath)) {
    throw new Error("Only pending export files can be saved with the native file picker");
  }

  let filePath: string | null = null;
  const pendingDir = relativePath.slice(0, relativePath.lastIndexOf("/"));
  try {
    try {
      const extension = fileExtension(fileName);
      filePath = await save({
        defaultPath: fileName,
        filters: extension
          ? [
              {
                name: extension === "db" ? "SQLite Database" : `${extension.toUpperCase()} File`,
                extensions: [extension],
              },
            ]
          : undefined,
      });
    } catch (error) {
      throw new Error(`save picker failed: ${describeError(error)}`);
    }

    if (filePath === null) {
      return false;
    }

    let didStartScopedAccess = false;
    try {
      await startAccessingSecurityScopedResource(filePath);
      didStartScopedAccess = true;
      await copyFileByHandle(relativePath, filePath, {
        fromPathBaseDir: BaseDirectory.AppData,
      });
    } catch (error) {
      throw new Error(
        `copyFile failed from ${relativePath} to ${filePath}: ${describeError(error)}`,
      );
    } finally {
      if (didStartScopedAccess) {
        await stopAccessingSecurityScopedResource(filePath).catch(() => undefined);
      }
    }
    return true;
  } finally {
    await removeAppDataPath(pendingDir);
  }
};

export const stagePickedDatabaseFileForRestore = async (
  pickedFilePath: string,
  signal?: AbortSignal,
): Promise<StagedRestore> => {
  const pendingDir = `scratch/portable-picked-${restoreId()}`;
  const relativePath = `${pendingDir}/restore.db`;

  try {
    await copyFileByHandle(pickedFilePath, relativePath, {
      toPathBaseDir: BaseDirectory.AppData,
      maxBytes: 2 * 1024 * 1024 * 1024,
      signal,
    });
    return { relativePath, pendingDir };
  } catch (error) {
    await removeAppDataPath(pendingDir);
    throw error;
  }
};

export const removeAppDataPath = async (relativePath: string): Promise<void> => {
  await invoke("profile_transfer_file", { relativePath, operation: "remove" }).catch(
    () => undefined,
  );
};

// ============================================================================
// Shell & Browser
// ============================================================================

export const openUrlInBrowser = async (url: string): Promise<void> => {
  await invoke("open_external_url", { url });
};
