import type { ExportOptions } from "@/lib/types";

/** Query parameters the server's export routes read the options from. */
export const exportOptionsQuery = (options?: ExportOptions): string => {
  if (!options) return "";
  const params = new URLSearchParams();
  params.set("includeArchived", String(options.includeArchived));
  if (options.startDate) params.set("startDate", options.startDate);
  if (options.endDate) params.set("endDate", options.endDate);
  return `?${params.toString()}`;
};
