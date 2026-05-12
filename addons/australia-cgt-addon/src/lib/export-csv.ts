import { exportReportCsv, type CgtReport } from "./cgt-engine";

export function downloadCsv(report: CgtReport) {
  const csv = exportReportCsv(report);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "wealthfolio-australia-cgt-report.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
