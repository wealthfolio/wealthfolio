import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import {
  Button,
  EmptyPlaceholder,
  Icons,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@wealthfolio/ui";
import {
  useCreateCategory,
  useDeleteCategory,
  useTaxonomy,
  useUpdateCategory,
} from "@/hooks/use-taxonomies";
import type { TaxonomyCategory } from "@/lib/types";

import { CategoryEditModal } from "@/features/spending/components/category-edit-modal";
import { CategoryItem, type CategoryNode } from "@/features/spending/components/category-item";
import type { CategoryFormValues } from "@/features/spending/components/category-form";
import { useSpendingSettings } from "@/features/spending/hooks/use-spending-settings";

import { SettingsHeader } from "../../settings-header";
import { SpendingBackLink } from "../components/spending-back-link";

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";
const SAVINGS_TAXONOMY = "savings_categories";

function buildTree(categories: TaxonomyCategory[]): CategoryNode[] {
  const byParent = new Map<string | null, CategoryNode[]>();
  for (const c of categories) {
    const parent = c.parentId ?? null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push({ ...c, children: undefined });
  }
  const attach = (parentId: string | null): CategoryNode[] => {
    const list = (byParent.get(parentId) ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
    return list.map((c) => ({ ...c, children: attach(c.id) }));
  };
  return attach(null);
}

export default function SpendingCategoriesPage() {
  const { t } = useTranslation();
  const { isEnabled, isLoading: settingsLoading } = useSpendingSettings();
  const [searchParams, setSearchParams] = useSearchParams();

  const spending = useTaxonomy(SPENDING_TAXONOMY);
  const income = useTaxonomy(INCOME_TAXONOMY);
  const savings = useTaxonomy(SAVINGS_TAXONOMY);
  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();
  const deleteCategory = useDeleteCategory();

  // URL is the source of truth for the active tab — no mirrored state, no sync effect.
  const activeTab: "expense" | "income" | "savings" =
    searchParams.get("tab") === "income"
      ? "income"
      : searchParams.get("tab") === "savings"
        ? "savings"
        : "expense";

  const handleTabChange = (value: string) => {
    setSearchParams(
      (prev) => {
        if (prev.get("tab") === value) return prev;
        const next = new URLSearchParams(prev);
        next.set("tab", value);
        return next;
      },
      { replace: true },
    );
  };

  const [visibleModal, setVisibleModal] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<CategoryNode | undefined>();
  const [parentCategory, setParentCategory] = useState<CategoryNode | undefined>();

  const expenseTree = useMemo(
    () => buildTree(spending.data?.categories ?? []),
    [spending.data?.categories],
  );
  const incomeTree = useMemo(
    () => buildTree(income.data?.categories ?? []),
    [income.data?.categories],
  );
  const savingsTree = useMemo(
    () => buildTree(savings.data?.categories ?? []),
    [savings.data?.categories],
  );
  const isLoading = spending.isLoading || income.isLoading || savings.isLoading;
  const total = expenseTree.length + incomeTree.length + savingsTree.length;
  const activeTaxonomyId =
    activeTab === "expense"
      ? SPENDING_TAXONOMY
      : activeTab === "income"
        ? INCOME_TAXONOMY
        : SAVINGS_TAXONOMY;

  if (!settingsLoading && !isEnabled) {
    return <Navigate to="/settings/spending" replace />;
  }

  const handleAddCategory = () => {
    setSelectedCategory(undefined);
    setParentCategory(undefined);
    setVisibleModal(true);
  };

  const handleAddSubcategory = (parent: CategoryNode) => {
    setSelectedCategory(undefined);
    setParentCategory(parent);
    setVisibleModal(true);
  };

  const handleEditCategory = (category: CategoryNode) => {
    setSelectedCategory(category);
    setParentCategory(undefined);
    setVisibleModal(true);
  };

  const handleDeleteCategory = (category: CategoryNode) => {
    deleteCategory.mutate(
      { taxonomyId: category.taxonomyId, categoryId: category.id },
      {
        onSuccess: () =>
          toast.success(t("settings:spending.categories.deleted", { name: category.name })),
        onError: () => toast.error(t("settings:spending.categories.delete_error")),
      },
    );
  };

  const slugify = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

  const handleSave = (values: CategoryFormValues) => {
    if (selectedCategory) {
      updateCategory.mutate(
        {
          ...selectedCategory,
          name: values.name,
          color: values.color ?? selectedCategory.color,
          icon: values.icon ?? null,
        },
        {
          onSuccess: () => {
            toast.success(t("settings:spending.categories.updated"));
            setVisibleModal(false);
          },
          onError: () => toast.error(t("settings:spending.categories.update_error")),
        },
      );
    } else {
      const taxonomyId = parentCategory ? parentCategory.taxonomyId : activeTaxonomyId;
      createCategory.mutate(
        {
          taxonomyId,
          parentId: parentCategory?.id ?? null,
          name: values.name,
          key: slugify(values.name) || `cat_${Date.now()}`,
          color: values.color ?? "#808080",
          sortOrder: 999,
          icon: values.icon ?? null,
        },
        {
          onSuccess: () => {
            toast.success(t("settings:spending.categories.created"));
            setVisibleModal(false);
          },
          onError: () => toast.error(t("settings:spending.categories.create_error")),
        },
      );
    }
  };

  const renderCategoryList = (categoryList: CategoryNode[]) => {
    if (categoryList.length === 0) {
      return (
        <div className="text-muted-foreground py-8 text-center text-sm">
          {t("settings:spending.categories.list_empty")}
        </div>
      );
    }
    return (
      <div className="divide-border divide-y rounded-md border">
        {categoryList.map((category) => (
          <CategoryItem
            key={category.id}
            category={category}
            // eslint-disable-next-line react/no-children-prop
            children={category.children}
            onEdit={handleEditCategory}
            onDelete={handleDeleteCategory}
            onAddSubcategory={handleAddSubcategory}
          />
        ))}
      </div>
    );
  };

  return (
    <>
      <div className="space-y-6">
        <SpendingBackLink />
        <SettingsHeader
          heading={t("settings:spending.categories.heading")}
          text={t("settings:spending.categories.text")}
          backTo="/settings/spending"
          actionsInline
        >
          <Button
            size="sm"
            className="sm:hidden"
            onClick={handleAddCategory}
            aria-label={t("settings:spending.categories.add")}
          >
            <Icons.Plus className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" className="hidden sm:inline-flex" onClick={handleAddCategory}>
            <Icons.Plus className="mr-2 h-3.5 w-3.5" />
            {t("settings:spending.categories.add")}
          </Button>
        </SettingsHeader>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : total === 0 ? (
          <EmptyPlaceholder>
            <EmptyPlaceholder.Icon name="Tag" />
            <EmptyPlaceholder.Title>
              {t("settings:spending.categories.empty_title")}
            </EmptyPlaceholder.Title>
            <EmptyPlaceholder.Description>
              {t("settings:spending.categories.empty_description")}
            </EmptyPlaceholder.Description>
            <Button onClick={handleAddCategory}>
              <Icons.Plus className="mr-2 h-4 w-4" />
              {t("settings:spending.categories.add")}
            </Button>
          </EmptyPlaceholder>
        ) : (
          <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
            <TabsList className="grid w-full max-w-md grid-cols-3">
              <TabsTrigger value="expense">
                {t("settings:spending.categories.tab_expense", { count: expenseTree.length })}
              </TabsTrigger>
              <TabsTrigger value="income">
                {t("settings:spending.categories.tab_income", { count: incomeTree.length })}
              </TabsTrigger>
              <TabsTrigger value="savings">
                {t("settings:spending.categories.tab_savings", { count: savingsTree.length })}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="expense" className="mt-6">
              {renderCategoryList(expenseTree)}
            </TabsContent>
            <TabsContent value="income" className="mt-6">
              {renderCategoryList(incomeTree)}
            </TabsContent>
            <TabsContent value="savings" className="mt-6">
              {renderCategoryList(savingsTree)}
            </TabsContent>
          </Tabs>
        )}
      </div>

      <CategoryEditModal
        open={visibleModal}
        onClose={() => setVisibleModal(false)}
        category={selectedCategory}
        parentCategory={parentCategory}
        onSave={handleSave}
        isLoading={createCategory.isPending || updateCategory.isPending}
      />
    </>
  );
}
