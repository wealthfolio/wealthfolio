import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  Skeleton,
} from "@wealthfolio/ui";
import { useTaxonomies } from "@/hooks/use-taxonomies";
import { SingleSelectTaxonomy } from "./single-select-taxonomy";
import { MultiSelectTaxonomy } from "./multi-select-taxonomy";
import { TickerAvatar } from "@/components/ticker-avatar";
import type { Taxonomy } from "@/lib/types";

interface ClassificationSheetProps {
  assetId: string;
  assetName?: string;
  assetSymbol?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * A sheet for classifying a single asset across all taxonomies.
 * Can be used from Assets page, Holdings page, and Asset Profile page.
 *
 * Layout:
 * - Single-select taxonomies at top (instrument_type, risk_category)
 * - Multi-select taxonomies below (asset_classes, industries, regions, custom)
 */
export function ClassificationSheet({
  assetId,
  assetName,
  assetSymbol,
  open,
  onOpenChange,
}: ClassificationSheetProps) {
  const { t } = useTranslation();
  // Asset classification sheet — restrict to asset-scoped taxonomies.
  const { data: taxonomies, isLoading } = useTaxonomies({ scope: "asset" });

  // Sort and group taxonomies
  const { singleSelectTaxonomies, multiSelectTaxonomies } = useMemo(() => {
    if (!taxonomies) {
      return { singleSelectTaxonomies: [], multiSelectTaxonomies: [] };
    }

    const sorted = [...taxonomies].sort((a, b) => a.sortOrder - b.sortOrder);
    const singleSelect: Taxonomy[] = [];
    const multiSelect: Taxonomy[] = [];

    sorted.forEach((taxonomy) => {
      if (taxonomy.isSingleSelect) {
        singleSelect.push(taxonomy);
      } else {
        multiSelect.push(taxonomy);
      }
    });

    return {
      singleSelectTaxonomies: singleSelect,
      multiSelectTaxonomies: multiSelect,
    };
  }, [taxonomies]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex h-full w-full flex-col sm:max-w-lg">
        <SheetHeader className="shrink-0 pb-4">
          <div className="flex items-center gap-3">
            {assetSymbol && <TickerAvatar symbol={assetSymbol} className="size-10" />}
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate text-lg">
                {assetSymbol || t("asset:classification.classifyAsset")}
              </SheetTitle>
              <SheetDescription className="truncate text-sm">{assetName}</SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-8 pb-8 pt-4">
            {/* Loading State */}
            {isLoading && <ClassificationSkeleton />}

            {/* Single-select taxonomies */}
            {!isLoading &&
              singleSelectTaxonomies.map((taxonomy) => (
                <SingleSelectTaxonomy
                  key={taxonomy.id}
                  taxonomyId={taxonomy.id}
                  assetId={assetId}
                  label={taxonomy.name}
                />
              ))}

            {/* Multi-select taxonomies */}
            {!isLoading &&
              multiSelectTaxonomies.map((taxonomy) => (
                <MultiSelectTaxonomy
                  key={taxonomy.id}
                  taxonomyId={taxonomy.id}
                  assetId={assetId}
                  label={taxonomy.name}
                />
              ))}

            {/* Empty state */}
            {!isLoading &&
              singleSelectTaxonomies.length === 0 &&
              multiSelectTaxonomies.length === 0 && (
                <div className="py-8 text-center">
                  <p className="text-muted-foreground text-sm">
                    {t("asset:classification.noTaxonomies")}
                  </p>
                </div>
              )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Loading skeleton for the classification sheet
 */
function ClassificationSkeleton() {
  return (
    <div className="space-y-8">
      {/* Single-select skeleton (2 items) */}
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={`single-${i}`} className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: 4 }).map((_, j) => (
              <Skeleton key={j} className="h-7 w-16 rounded-full" />
            ))}
          </div>
        </div>
      ))}

      {/* Multi-select skeleton (4 items) */}
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={`multi-${i}`} className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
      ))}
    </div>
  );
}
