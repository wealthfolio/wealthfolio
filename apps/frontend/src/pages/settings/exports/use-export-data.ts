import i18n from "i18next";
import { exportDataFile, logger } from "@/adapters";
import type { ExportedFileFormat, ExportOptions, ExportTarget } from "@/lib/types";
import { useMutation } from "@tanstack/react-query";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

interface ExportParams {
  format: ExportedFileFormat;
  data: ExportTarget;
  options: ExportOptions;
}

interface FileExportResult {
  filename?: string;
}

type ExportMutationResult = FileExportResult | null;

export function useExportData() {
  const {
    mutateAsync: exportDataMutation,
    isPending: isExporting,
    variables: mutationVariables,
  } = useMutation<ExportMutationResult, Error, ExportParams>({
    mutationFn: async ({ format, data, options }: ExportParams) => {
      const result = await exportDataFile(format, data, options);
      if (result.status === "empty") {
        toast({
          title: i18n.t("common:notifications.nothing_to_export"),
          description: i18n.t(
            data === "all" ? "settings:data_export.empty_all" : "settings:data_export.empty",
          ),
        });
        return null;
      }

      if (result.status === "canceled") {
        return null;
      }

      return { filename: result.filename };
    },
    onSuccess: (result) => {
      if (!result) {
        // User cancelled the operation, don't show any message
        return;
      }

      toast({
        title: i18n.t("common:notifications.export_completed"),
        description: i18n.t("common:notifications.file_saved_description"),
        variant: "success",
      });
    },
    onError: (e) => {
      logger.error(`Error while exporting: ${String(e)}`);
      toast({
        title: i18n.t("common:notifications.export_failed"),
        description: e.message || i18n.t("common:notifications.export_failed"),
        variant: "destructive",
      });
    },
  });

  const exportData = async (params: ExportParams) => {
    try {
      await exportDataMutation(params);
    } catch (error) {
      logger.error(`Error while exporting: ${String(error)}`);
    }
  };

  return {
    exportData,
    isExporting,
    exportingData: isExporting ? mutationVariables?.data : null,
  };
}
