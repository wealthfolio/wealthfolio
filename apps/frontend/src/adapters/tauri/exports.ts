import type { ExportDataType, ExportedFileFormat } from "@/lib/types";
import type { DataExportResult } from "../types";
import { invoke } from "./core";
import { saveAppDataFileViaPicker } from "./files";

type DataExportFileFormat = Exclude<ExportedFileFormat, "SQLite">;

interface BackendDataExportResult {
  status: "saved" | "pending" | "empty" | "canceled";
  relativePath?: string;
  filename?: string;
}

export const exportDataFile = async (
  format: DataExportFileFormat,
  data: ExportDataType,
): Promise<DataExportResult> => {
  const result = await invoke<BackendDataExportResult>("export_data_file", {
    dataType: data,
    format,
  });

  if (result.status === "pending") {
    if (!result.relativePath || !result.filename) {
      throw new Error("Export did not return a pending file path");
    }

    const saved = await saveAppDataFileViaPicker(result.relativePath, result.filename);
    return saved ? { status: "saved", filename: result.filename } : { status: "canceled" };
  }

  return {
    status: result.status,
    filename: result.filename,
  };
};
