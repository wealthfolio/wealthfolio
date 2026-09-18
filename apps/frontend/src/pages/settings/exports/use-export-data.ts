import { exportDataFile, logger } from "@/adapters";
import { ExportDataType, ExportedFileFormat } from "@/lib/types";
import { useMutation } from "@tanstack/react-query";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

interface ExportParams {
  format: ExportedFileFormat;
  data: ExportDataType;
}

interface FileExportResult {
  filename?: string;
}

type ExportMutationResult = FileExportResult | null;

const datasetLabels: Record<ExportDataType, string> = {
  accounts: "accounts",
  activities: "activities",
  holdings: "holdings",
  goals: "goals",
  "portfolio-history": "portfolio history records",
};

export function useExportData() {
  const {
    mutateAsync: exportDataMutation,
    isPending: isExporting,
    variables: mutationVariables,
  } = useMutation<ExportMutationResult, Error, ExportParams>({
    mutationFn: async (params: ExportParams) => {
      const { format, data: desiredData } = params;
      const result = await exportDataFile(format, desiredData);
      if (result.status === "empty") {
        toast({
          title: "Nothing to export.",
          description: `No ${datasetLabels[desiredData]} available to export right now.`,
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
        title: "Export completed",
        description: "File saved successfully. Check your download location.",
        variant: "success",
      });
    },
    onError: (e) => {
      logger.error(`Error while exporting: ${String(e)}`);
      toast({
        title: "Export failed.",
        description: e.message || "The export could not be completed.",
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
    exportingFormat: isExporting ? mutationVariables?.format : null,
    exportingData: isExporting ? mutationVariables?.data : null,
  };
}
