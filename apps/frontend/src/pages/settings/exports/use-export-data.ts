import {
  backupDatabase,
  backupDatabaseToPath,
  backupDatabaseToPendingExport,
  exportDataFile,
  isWeb,
  logger,
  openFolderDialog,
  saveAppDataFileViaPicker,
} from "@/adapters";
import { getPlatform as getRuntimePlatform } from "@/hooks/use-platform";
import { ExportDataType, ExportedFileFormat } from "@/lib/types";
import { useMutation } from "@tanstack/react-query";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

interface ExportParams {
  format: ExportedFileFormat;
  data: ExportDataType;
}

interface SQLiteBackupResult {
  mode: "sqlite";
  target: "local" | "server";
  value: string;
}

interface FileExportResult {
  mode: "file";
  filename?: string;
}

type ExportMutationResult = SQLiteBackupResult | FileExportResult | null;

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
      if (format === "SQLite") {
        if (isWeb) {
          const { filename } = await backupDatabase();
          return { mode: "sqlite", target: "server" as const, value: filename };
        }

        const runtimePlatform = await getRuntimePlatform();
        if (runtimePlatform.is_desktop) {
          // Open folder dialog to let user choose backup location
          const selectedDir = await openFolderDialog();

          if (!selectedDir) {
            // User cancelled the dialog, return null to indicate cancellation
            return null;
          }

          // Create backup in selected directory
          const backupPath = await backupDatabaseToPath(selectedDir);
          return { mode: "sqlite", target: "local" as const, value: backupPath };
        }

        if (runtimePlatform.os !== "ios") {
          throw new Error("SQLite export is currently supported on desktop, web, and iOS only");
        }

        // iOS: create backup and let user pick destination file.
        const { relativePath, filename } = await backupDatabaseToPendingExport();
        const saved = await saveAppDataFileViaPicker(relativePath, filename);
        if (!saved) {
          return null;
        }
        return { mode: "sqlite", target: "local" as const, value: filename };
      }

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

      return { mode: "file", filename: result.filename };
    },
    onSuccess: (result) => {
      if (!result) {
        // User cancelled the operation, don't show any message
        return;
      }

      if (result.mode === "sqlite") {
        const description =
          result.target === "server"
            ? `Backup created on the server as ${result.value}`
            : `Backup saved as ${result.value}`;

        toast({
          title: "Database backup completed successfully.",
          description,
          variant: "success",
        });
      } else {
        // Regular export success
        toast({
          title: "Export completed",
          description: "File saved successfully. Check your download location.",
          variant: "success",
        });
      }
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
