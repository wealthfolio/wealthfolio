import { profileFetch } from "@/features/profiles/session";
import type { ExportedFileFormat, ExportOptions, ExportTarget } from "@/lib/types";
import { exportOptionsQuery } from "./export-options";
import { notifyUnauthorized } from "@/lib/auth-token";
import type { DataExportResult } from "../types";
import { API_PREFIX } from "./core";

const fallbackFileName = (data: ExportTarget, format: ExportedFileFormat): string => {
  const currentDate = new Date().toISOString().split("T")[0];
  if (data === "all") {
    return `wealthfolio-export_${currentDate}.${format === "CSV" ? "zip" : "json"}`;
  }
  return `${data}_${currentDate}.${format.toLowerCase()}`;
};

const filenameFromContentDisposition = (value: string | null): string | null => {
  if (!value) return null;

  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }

  const quotedMatch = /filename="([^"]+)"/i.exec(value);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  const bareMatch = /filename=([^;]+)/i.exec(value);
  return bareMatch?.[1]?.trim() ?? null;
};

const downloadBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export const exportDataFile = async (
  format: ExportedFileFormat,
  data: ExportTarget,
  options?: ExportOptions,
): Promise<DataExportResult> => {
  const url = `${API_PREFIX}/utilities/export/${encodeURIComponent(data)}/${encodeURIComponent(
    format.toLowerCase(),
  )}${exportOptionsQuery(options)}`;

  const response = await profileFetch(url, {
    method: "GET",
    credentials: "same-origin",
  });

  if (response.status === 401) {
    notifyUnauthorized();
  }

  if (response.status === 204) {
    return { status: "empty" };
  }

  if (!response.ok) {
    let message = response.statusText;
    try {
      const error = await response.json();
      message = (error?.message ?? message) as string;
    } catch {
      // Keep the HTTP status text when the server did not return JSON.
    }
    throw new Error(message);
  }

  const filename =
    filenameFromContentDisposition(response.headers.get("Content-Disposition")) ??
    fallbackFileName(data, format);
  const blob = await response.blob();
  downloadBlob(blob, filename);

  return { status: "saved", filename };
};
