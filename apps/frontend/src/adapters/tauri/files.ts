// File Dialogs
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  BaseDirectory,
  copyFile,
  remove,
  startAccessingSecurityScopedResource,
  stopAccessingSecurityScopedResource,
} from "@tauri-apps/plugin-fs";

import { invoke } from "./core";

interface PendingExport {
  relativePath: string;
  filename: string;
}

const isIOSUserAgent = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  const userAgent = window.navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod/.test(userAgent);
};

const isIOSRuntime = async (): Promise<boolean> => {
  try {
    const platform = await invoke<{ os: string }>("get_platform");
    return platform.os === "ios";
  } catch {
    return isIOSUserAgent();
  }
};

const fileExtension = (fileName: string): string | null => {
  const extension = fileName.split(".").pop();
  return extension && extension !== fileName ? extension : null;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
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
    if (await isIOSRuntime()) {
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
  if (await isIOSRuntime()) {
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
      await copyFile(relativePath, filePath, {
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
    await remove(relativePath, { baseDir: BaseDirectory.AppData }).catch(() => undefined);
    await remove(pendingDir, { baseDir: BaseDirectory.AppData }).catch(() => undefined);
  }
};

// ============================================================================
// Shell & Browser
// ============================================================================

export const openUrlInBrowser = async (url: string): Promise<void> => {
  await invoke("open_external_url", { url });
};
