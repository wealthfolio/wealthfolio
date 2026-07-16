import { AllocationBreadcrumb } from "@/components/allocation-breadcrumb";
import { useDrillDownState } from "@/hooks/use-drill-down-state";
import type { TaxonomyAllocation, CategoryAllocation } from "@/lib/types";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DonutChart,
  EmptyPlaceholder,
  Skeleton,
} from "@wealthfolio/ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

interface DrillableDonutChartProps {
  title: string;
  allocation?: TaxonomyAllocation;
  baseCurrency?: string;
  isLoading?: boolean;
  onCategoryClick?: (categoryId: string, categoryName: string) => void;
  onCardClick?: () => void;
}

/**
 * A semi-donut chart with drill-down capability.
 * At root level, shows top-level categories from TaxonomyAllocation.
 * When drilled, shows children from allocation.categories[].children.
 */
export function DrillableDonutChart({
  title,
  allocation,
  baseCurrency = "USD",
  isLoading,
  onCategoryClick,
  onCardClick,
}: DrillableDonutChartProps) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);
  const { path, drillDown, navigateTo, isAtRoot } = useDrillDownState();

  // Find category by ID from allocation
  const findCategory = (categoryId: string): CategoryAllocation | undefined => {
    return allocation?.categories?.find((cat) => cat.categoryId === categoryId);
  };

  // Root level data from allocation
  const rootData = useMemo(() => {
    if (!allocation?.categories?.length) return [];

    return allocation.categories
      .filter((cat) => cat.value > 0)
      .map((cat) => ({
        id: cat.categoryId,
        name: cat.categoryName,
        value: cat.value,
        currency: baseCurrency,
        color: cat.color,
      }));
  }, [allocation, baseCurrency]);

  // Drilled-down data from allocation.categories[].children
  const drilledData = useMemo(() => {
    if (path.length === 0) return [];

    const currentCategoryId = path[path.length - 1].id;
    const category = findCategory(currentCategoryId);

    if (!category?.children?.length) return [];

    return category.children
      .filter((child) => child.value > 0)
      .map((child) => ({
        id: child.categoryId,
        name: child.categoryName,
        value: child.value,
        currency: baseCurrency,
        color: child.color,
      }))
      .sort((a, b) => b.value - a.value);
  }, [path, allocation, baseCurrency]);

  const data = isAtRoot ? rootData : drilledData;

  const handleSectionClick = (
    sectionData: { name: string; value: number; currency: string },
    index: number,
  ) => {
    setActiveIndex(index);

    const clickedItem = data.find((d) => d.name === sectionData.name);
    if (!clickedItem) return;

    // At root level, check if this category has children to drill into
    if (isAtRoot) {
      const category = findCategory(clickedItem.id);
      if (category?.children && category.children.length > 0) {
        // Drill down to show children
        drillDown(clickedItem.id, clickedItem.name);
        setActiveIndex(0);
        return;
      }
    }

    // No children or already drilled - open the sheet
    onCategoryClick?.(clickedItem.id, clickedItem.name);
  };

  const handleBreadcrumbNavigate = (index: number) => {
    navigateTo(index);
    setActiveIndex(0);
  };

  if (isLoading) {
    return (
      <Card className="overflow-hidden backdrop-blur-sm">
        <CardHeader className="px-5 pb-1 pt-5">
          <Skeleton className="h-4 w-[120px]" />
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-0">
          <div className="flex h-[160px] items-center justify-center">
            <Skeleton className="h-[120px] w-[120px] rounded-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className="hover:bg-muted/50 cursor-pointer overflow-hidden backdrop-blur-sm transition-colors"
      onClick={onCardClick}
    >
      <CardHeader className="px-5 pb-1 pt-5">
        {isAtRoot ? (
          <CardTitle className="text-muted-foreground text-[12px] font-semibold uppercase tracking-[0.18em]">
            {title}
          </CardTitle>
        ) : (
          <div onClick={(e) => e.stopPropagation()}>
            <AllocationBreadcrumb
              path={path}
              rootLabel={title}
              onNavigate={handleBreadcrumbNavigate}
            />
          </div>
        )}
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-0">
        {data.length > 0 ? (
          <DonutChart
            data={data}
            activeIndex={activeIndex}
            onSectionClick={handleSectionClick}
            startAngle={180}
            endAngle={0}
          />
        ) : (
          <EmptyPlaceholder
            description={t("holdings:no_typed_data_available", { type: title.toLowerCase() })}
            className="max-h-[160px]"
          />
        )}
      </CardContent>
    </Card>
  );
}
