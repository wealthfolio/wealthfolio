import { useTranslation } from "react-i18next";
import type { NumericColumnAnalysis } from "../utils/numeric-format";
import { ImportAlert } from "./import-alert";

interface NumericFormatAlertProps {
  columns: Record<string, NumericColumnAnalysis>;
  fieldMappings: Record<string, string | string[]>;
}

export function NumericFormatAlert({ columns, fieldMappings }: NumericFormatAlertProps) {
  const { t } = useTranslation();
  const affectedColumns = Object.entries(columns)
    .filter(([, analysis]) => analysis.issue)
    .flatMap(([field]) => fieldMappings[field] ?? []);
  if (affectedColumns.length === 0) return null;

  return (
    <ImportAlert
      variant="warning"
      size="sm"
      title={t("activity:import.parseSettings.numberFormatWarningTitle")}
      description={t("activity:import.parseSettings.numberFormatWarningDescription", {
        columns: [...new Set(affectedColumns)].join(", "),
      })}
      className="mb-0"
    />
  );
}
