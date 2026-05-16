// File Dialogs
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  BaseDirectory,
  copyFile,
  remove,
  startAccessingSecurityScopedResource,
  stopAccessingSecurityScopedResource,
  writeFile,
} from "@tauri-apps/plugin-fs";

const isIOS = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  const userAgent = window.navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod/.test(userAgent);
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

const shareFileOnIOS = async (content: Uint8Array, fileName: string): Promise<boolean> => {
  try {
    const { shareBinary } = await import("tauri-plugin-mobile-share");

    const extensionIndex = fileName.lastIndexOf(".");
    const hasExtension = extensionIndex > 0 && extensionIndex < fileName.length - 1;
    const name = hasExtension ? fileName.slice(0, extensionIndex) : fileName;
    const ext = hasExtension ? fileName.slice(extensionIndex + 1) : "db";

    await shareBinary(toBase64(content), { name, ext });
    return true;
  } catch {
    return false;
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
  let contentToSave: Uint8Array;
  if (typeof fileContent === "string") {
    contentToSave = new TextEncoder().encode(fileContent);
  } else if (fileContent instanceof Blob) {
    const arrayBuffer = await fileContent.arrayBuffer();
    contentToSave = new Uint8Array(arrayBuffer);
  } else {
    contentToSave = fileContent;
  }

  if (isIOS()) {
    return await shareFileOnIOS(contentToSave, fileName);
  }

  const filePath = await save({
    defaultPath: fileName,
    filters: [
      {
        name: fileName,
        extensions: [fileName.split(".").pop() ?? ""],
      },
    ],
  });

  if (filePath === null) {
    return false;
  }

  const candidatePaths = [filePath];
  if (filePath.startsWith("file://")) {
    candidatePaths.push(decodeURI(filePath.replace("file://", "")));
  } else {
    candidatePaths.push(`file://${filePath}`);
  }

  let lastError: unknown;
  for (const candidatePath of candidatePaths) {
    try {
      await writeFile(candidatePath, contentToSave);
      return true;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

export const saveAppDataFileViaPicker = async (
  relativePath: string,
  fileName: string,
): Promise<boolean> => {
  if (!/^pending-exports\/[^/\\]+$/.test(relativePath)) {
    throw new Error("Only pending export files can be saved with the native file picker");
  }

  let filePath: string | null = null;
  try {
    try {
      filePath = await save({
        defaultPath: fileName,
        filters: [
          {
            name: "SQLite Database",
            extensions: ["db"],
          },
        ],
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
  }
};

// ============================================================================
// Shell & Browser
// ============================================================================

export const openUrlInBrowser = async (url: string): Promise<void> => {
  const { open: openShell } = await import("@tauri-apps/plugin-shell");
  await openShell(url);
};
