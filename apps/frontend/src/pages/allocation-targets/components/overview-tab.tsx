import { useTranslation } from "react-i18next";
import type { AllocationTarget, DriftReport } from "@/lib/types";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { CurrentVsTargetCard } from "./current-vs-target-card";
import { DriftDriversCard } from "./drift-drivers-card";
import { HoldingsTable } from "./holdings-table";
import { resolveDriftReportCategories } from "./drift-report-resolver";
import { categoryNoun, formatTolerance, taxonomyLabel, targetLabel } from "./drift-copy";

interface OverviewTabProps {
  report: DriftReport;
  taxonomyId: string;
  targetName?: string;
  target?: AllocationTarget | null;
  onRebalanceClick?: () => void;
}

export function OverviewTab({
  report,
  taxonomyId,
  targetName,
  target,
  onRebalanceClick,
}: OverviewTabProps) {
  const { t } = useTranslation();
  const { data: taxonomy } = useTaxonomy(taxonomyId);
  const resolvedReport = resolveDriftReportCategories(report, taxonomy?.categories);
  const taxonomyName = taxonomy?.taxonomy.name;
  const categoryLabel = categoryNoun(taxonomyId, taxonomyName, report.outOfBandCount);
  const pluralCategoryLabel = categoryNoun(taxonomyId, taxonomyName, 2);
  const displayTaxonomy = taxonomyLabel(taxonomyId, taxonomyName);
  const gapStatus =
    report.outOfBandCount === 0
      ? t("allocation:overview.allInsideTarget", { categories: pluralCategoryLabel })
      : t("allocation:overview.outsideTarget", {
          n: report.outOfBandCount,
          categories: categoryLabel,
        });

  const bandLabel = (() => {
    if (!target) return null;
    const isHybrid = target.bandType === "hybrid";
    const typeName = isHybrid ? t("allocation:band.hybrid") : t("allocation:band.absolute");
    const requiredRows = resolvedReport.rows.filter((r) => r.isRequired && r.targetBps > 0);
    if (!requiredRows.length) return `${typeName} · ${formatTolerance(target.driftBandBps)}`;
    const bands = requiredRows.map((r) => r.effectiveBandBps);
    const minBand = Math.min(...bands);
    const maxBand = Math.max(...bands);
    const range =
      minBand === maxBand
        ? formatTolerance(minBand)
        : `±${(minBand / 100).toFixed(1)}–${(maxBand / 100).toFixed(1)}%`;
    return `${typeName} · ${range}`;
  })();

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(340px,0.75fr)]">
        <CurrentVsTargetCard
          report={resolvedReport}
          taxonomyLabel={displayTaxonomy}
          targetLabel={targetLabel(targetName)}
        />
        <DriftDriversCard
          report={resolvedReport}
          statusDescription={gapStatus}
          bandLabel={bandLabel}
          onRebalanceClick={onRebalanceClick}
        />
      </div>

      <HoldingsTable report={resolvedReport} />
    </div>
  );
}
