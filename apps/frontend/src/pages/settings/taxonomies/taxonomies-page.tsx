import { useState, useMemo } from "react";
import { Icons, ScrollArea, Card, Button, Tabs, TabsList, TabsTrigger } from "@wealthfolio/ui";
import {
  TreeView,
  buildCategoryTree,
  type TreeNode,
} from "@wealthfolio/ui/components/ui/tree-view";
import { useTaxonomies, useTaxonomy, useExportTaxonomy } from "@/hooks/use-taxonomies";
import { SettingsHeader } from "../settings-header";
import { CategoryForm } from "./components/category-form";
import { MigrationBanner } from "./migration-banner";
import { toast } from "sonner";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

export default function TaxonomiesPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  // Settings → Classifications is asset-only. Spending categories live at /settings/spending/categories.
  const { data: taxonomies = [], isLoading: isLoadingTaxonomies } = useTaxonomies({
    scope: "asset",
  });
  const [selectedTaxonomyId, setSelectedTaxonomyId] = useState<string | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const exportMutation = useExportTaxonomy();

  // Auto-select first taxonomy if none selected
  const activeTaxonomyId = selectedTaxonomyId ?? taxonomies[0]?.id ?? null;
  const activeTaxonomy = taxonomies.find((t) => t.id === activeTaxonomyId);

  // Custom Groups is editable even though it's a system taxonomy
  const isEditableTaxonomy = !activeTaxonomy?.isSystem || activeTaxonomyId === "custom_groups";

  const { data: taxonomyWithCategories, isLoading: isLoadingCategories } =
    useTaxonomy(activeTaxonomyId);

  // Build tree from categories
  const categoryTree = useMemo(() => {
    if (!taxonomyWithCategories?.categories) return [];
    return buildCategoryTree(taxonomyWithCategories.categories);
  }, [taxonomyWithCategories?.categories]);

  // Find selected category
  const selectedCategory = useMemo(() => {
    if (!selectedCategoryId || !taxonomyWithCategories?.categories) return null;
    return taxonomyWithCategories.categories.find((c) => c.id === selectedCategoryId) ?? null;
  }, [selectedCategoryId, taxonomyWithCategories?.categories]);

  const handleSelectCategory = (node: TreeNode) => {
    setSelectedCategoryId(node.id);
    setIsCreatingCategory(false);
  };

  const handleAddCategory = () => {
    setSelectedCategoryId(null);
    setIsCreatingCategory(true);
  };

  const handleCategoryCreated = () => {
    setIsCreatingCategory(false);
  };

  const handleExport = async () => {
    if (!activeTaxonomyId) return;
    try {
      const json = await exportMutation.mutateAsync(activeTaxonomyId);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${activeTaxonomy?.name ?? "taxonomy"}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t("settings:tax_export_success"));
    } catch {
      toast.error(t("settings:tax_export_error"));
    }
  };

  const isLoading = isLoadingTaxonomies || isLoadingCategories;
  const showHealthBanner = searchParams.get("healthContext") === "classification";

  return (
    <div className="space-y-6">
      <SettingsHeader
        heading={t("settings:nav.items.classifications")}
        text={t("settings:tax_page_description")}
      />

      {showHealthBanner && (
        <div className="border-border bg-muted/30 flex items-center justify-between gap-3 rounded-md border px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Icons.Info className="text-muted-foreground h-4 w-4 shrink-0" />
            <p className="text-sm">{t("settings:health_banner_classification")}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setSearchParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  next.delete("healthContext");
                  return next;
                },
                { replace: true },
              )
            }
          >
            {t("settings:health_banner_clear")}
          </Button>
        </div>
      )}

      <MigrationBanner />

      {/* Taxonomy tabs */}
      {isLoadingTaxonomies ? (
        <div className="text-muted-foreground text-sm">{t("settings:tax_loading_generic")}</div>
      ) : taxonomies.length === 0 ? (
        <div className="text-muted-foreground text-sm">
          {t("settings:tax_no_classifications_found")}
        </div>
      ) : (
        <Tabs
          value={activeTaxonomyId ?? undefined}
          onValueChange={(value) => {
            setSelectedTaxonomyId(value);
            setSelectedCategoryId(null);
          }}
        >
          <div className="overflow-x-auto [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TabsList className="inline-flex w-max justify-start gap-2">
              {taxonomies.map((taxonomy) => (
                <TabsTrigger
                  key={taxonomy.id}
                  value={taxonomy.id}
                  className="flex shrink-0 items-center gap-2"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: taxonomy.color }}
                  />
                  <span>{taxonomy.name.replace(" (GICS)", "")}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
      )}

      {/* Main content area */}
      {activeTaxonomyId && taxonomyWithCategories ? (
        <Card>
          {/* Header with export button */}
          <div className="flex items-center justify-between border-b p-4">
            <div className="flex items-center gap-3">
              <span
                className="h-4 w-4 rounded-full"
                style={{ backgroundColor: activeTaxonomy?.color }}
              />
              <div>
                <h3 className="font-semibold">{activeTaxonomy?.name}</h3>
                <p className="text-muted-foreground text-xs">
                  {t("settings:tax_categories_count", {
                    count: taxonomyWithCategories.categories.length,
                  })}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isEditableTaxonomy && (
                <Button variant="default" size="sm" onClick={handleAddCategory}>
                  <Icons.Plus className="mr-2 h-4 w-4" />
                  {t("settings:tax_add_category")}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={handleExport}>
                <Icons.Download className="mr-2 h-4 w-4" />
                {t("settings:tax_export")}
              </Button>
            </div>
          </div>

          {/* Categories and details */}
          <div className="flex min-h-[500px] flex-col lg:flex-row">
            {/* Category tree */}
            <div className="w-full border-b lg:w-80 lg:border-b-0 lg:border-r">
              <ScrollArea className="h-[300px] lg:h-[500px]">
                {isLoadingCategories ? (
                  <div className="text-muted-foreground p-4 text-center text-sm">
                    {t("settings:tax_loading_generic")}
                  </div>
                ) : categoryTree.length === 0 ? (
                  <div className="text-muted-foreground p-4 text-center text-sm">
                    {t("settings:tax_no_categories")}
                  </div>
                ) : (
                  <TreeView
                    data={categoryTree}
                    selectedId={selectedCategoryId}
                    onSelect={handleSelectCategory}
                    defaultExpandedIds={categoryTree.slice(0, 5).map((n: TreeNode) => n.id)}
                  />
                )}
              </ScrollArea>
            </div>

            {/* Category details */}
            <div className="flex-1 p-4">
              {isCreatingCategory ? (
                <CategoryForm
                  taxonomyId={activeTaxonomyId}
                  taxonomyColor={activeTaxonomy?.color}
                  onClose={() => setIsCreatingCategory(false)}
                  onCreate={handleCategoryCreated}
                />
              ) : selectedCategory ? (
                <CategoryForm
                  category={selectedCategory}
                  taxonomyId={activeTaxonomyId}
                  isSystem={!isEditableTaxonomy}
                  onClose={() => setSelectedCategoryId(null)}
                  onDelete={() => setSelectedCategoryId(null)}
                />
              ) : (
                <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                  <div className="text-center">
                    <Icons.Info className="mx-auto mb-2 h-8 w-8 opacity-50" />
                    <p>{t("settings:tax_select_category_details")}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>
      ) : isLoading ? (
        <Card className="flex h-64 items-center justify-center">
          <div className="text-muted-foreground text-center">
            <Icons.Loader className="mx-auto mb-2 h-6 w-6 animate-spin" />
            <p>{t("settings:tax_loading")}</p>
          </div>
        </Card>
      ) : (
        <Card className="flex h-64 items-center justify-center">
          <div className="text-muted-foreground text-center">
            <Icons.Blocks className="mx-auto mb-2 h-8 w-8 opacity-50" />
            <p>{t("settings:tax_select_classification")}</p>
          </div>
        </Card>
      )}
    </div>
  );
}
