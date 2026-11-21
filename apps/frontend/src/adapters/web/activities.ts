import { profileFetch } from "@/features/profiles/session";
// Web-specific activity commands
import type { ParseConfig, ParsedCsvResult } from "@/lib/types";
import { API_PREFIX, logger } from "./core";
import { invokeTimeoutMs } from "../invoke-timeout";

async function extractErrorMessage(response: Response): Promise<string | null> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.json()) as {
        message?: unknown;
        error?: unknown;
      };
      if (typeof payload.message === "string" && payload.message.trim()) {
        return payload.message.trim();
      }
      if (typeof payload.error === "string" && payload.error.trim()) {
        return payload.error.trim();
      }
    } catch {
      // Fall through to text parsing
    }
  }

  try {
    const text = (await response.text()).trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Parse a CSV file with the given configuration.
 * Web implementation: POSTs multipart form data to /api/v1/activities/import/parse.
 */
export const parseCsv = async (file: File, config: ParseConfig): Promise<ParsedCsvResult> => {
  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("config", JSON.stringify(config));

    const response = await profileFetch(`${API_PREFIX}/activities/import/parse`, {
      method: "POST",
      body: formData,
      credentials: "same-origin",
      signal: AbortSignal.timeout(invokeTimeoutMs("parse_csv")),
    });

    if (!response.ok) {
      const details = await extractErrorMessage(response);
      const fallback = `Request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})`;
      throw new Error(
        details ? `Failed to parse CSV: ${details}` : `Failed to parse CSV: ${fallback}`,
      );
    }

    const parsed = (await response.json()) as ParsedCsvResult;
    return parsed;
  } catch (err) {
    logger.error("Error parsing CSV file:", err);
    throw err;
  }
};
