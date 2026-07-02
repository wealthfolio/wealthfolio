import type { AllocationTarget, DriftReport } from "@/lib/types";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { useI18n } from "@/i18n/i18n-provider";
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
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const { data: taxonomy } = useTaxonomy(taxonomyId);
  const resolvedReport = resolveDriftReportCategories(report, taxonomy?.categories);
  const taxonomyName = taxonomy?.taxonomy.name;
  const categoryLabel = categoryNoun(taxonomyId, taxonomyName, report.outOfBandCount, language);
  const pluralCategoryLabel = categoryNoun(taxonomyId, taxonomyName, 2, language);
  const displayTaxonomy = taxonomyLabel(taxonomyId, taxonomyName, language);
  const gapStatus =
    report.outOfBandCount === 0
      ? isChinese
        ? `所有${pluralCategoryLabel}均在目标范围内`
        : `All ${pluralCategoryLabel} inside target`
      : isChinese
        ? `${report.outOfBandCount} 个${categoryLabel}超出目标范围`
        : `${report.outOfBandCount} ${categoryLabel} outside target`;

  const bandLabel = (() => {
    if (!target) return null;
    const isHybrid = target.bandType === "hybrid";
    const typeName = isHybrid
      ? isChinese
        ? "混合"
        : "Hybrid"
      : isChinese
        ? "固定"
        : "Absolute";
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
          targetLabel={targetLabel(targetName, language)}
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
