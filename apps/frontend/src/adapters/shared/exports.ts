import type { ExportDatasetSummary, ExportOptions } from "@/lib/types";
import { invoke } from "./platform";

/** How much each export dataset holds, before anything is downloaded. */
export const getDataExportSummary = (options: ExportOptions): Promise<ExportDatasetSummary[]> =>
  invoke<ExportDatasetSummary[]>("get_data_export_summary", { options });
