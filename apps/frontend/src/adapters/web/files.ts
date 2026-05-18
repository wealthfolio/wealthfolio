// Web adapter - File Dialogs (web implementations)

/**
 * Open a file dialog for CSV files.
 * Web implementation - not fully supported, returns null.
 */
export const openCsvFileDialog = (): Promise<null | string | string[]> => {
  // Web implementation would use file input - return null to indicate not supported
  return Promise.resolve(null);
};

/**
 * Open a folder selection dialog.
 * Not supported in web.
 */
export const openFolderDialog = (): Promise<string | null> => {
  // Not supported in web
  return Promise.resolve(null);
};

/**
 * Open a file dialog for database files.
 * Not supported in web.
 */
export const openDatabaseFileDialog = (): Promise<string | null> => {
  // Not supported in web
  return Promise.resolve(null);
};

/**
 * Open a file save dialog and save content.
 * Web implementation using download.
 */
export const openFileSaveDialog = (
  fileContent: string | Blob | Uint8Array,
  fileName: string,
): Promise<boolean> => {
  // Web implementation using download
  try {
    let blob: Blob;
    if (typeof fileContent === "string") {
      blob = new Blob([fileContent], { type: "text/plain" });
    } else if (fileContent instanceof Blob) {
      blob = fileContent;
    } else {
      blob = new Blob([fileContent as BlobPart]);
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
};

export const saveAppDataFileViaPicker = (
  _relativePath: string,
  _fileName: string,
): Promise<boolean> => {
  return Promise.reject(
    new Error("App data file picker export is only supported in the Tauri app"),
  );
};

// ============================================================================
// Shell & Browser
// ============================================================================

/**
 * Open a URL in the browser.
 */
export const openUrlInBrowser = (url: string): Promise<void> => {
  window.open(url, "_blank");
  return Promise.resolve();
};
