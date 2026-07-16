import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Icons,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui";
import type { TaxonomyCategory } from "@/lib/types";

import { ActionPalette, type ActionPaletteGroup } from "@/components/action-palette";

import { CategoryIcon } from "./category-chips";

export interface CategoryNode extends TaxonomyCategory {
  children?: CategoryNode[];
}

interface CategoryItemProps {
  category: CategoryNode;
  children?: CategoryNode[];
  onEdit: (category: CategoryNode) => void;
  onDelete: (category: CategoryNode) => void;
  onAddSubcategory: (parentCategory: CategoryNode) => void;
  isSubcategory?: boolean;
  activityCounts?: Record<string, number>;
}

export function CategoryItem({
  category,
  children,
  onEdit,
  onDelete,
  onAddSubcategory,
  isSubcategory = false,
  activityCounts,
}: CategoryItemProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const hasChildren = children && children.length > 0;
  const activityCount = activityCounts?.[category.id] ?? 0;

  const paletteGroups: ActionPaletteGroup[] = [
    {
      items: [
        ...(!isSubcategory
          ? [
              {
                icon: Icons.Plus,
                label: t("spending:category.addSubcategory"),
                onClick: () => onAddSubcategory(category),
              },
            ]
          : []),
        {
          icon: Icons.Pencil,
          label: t("common:edit"),
          onClick: () => onEdit(category),
        },
      ],
    },
    {
      items: [
        {
          icon: Icons.Trash,
          label: t("common:delete"),
          variant: "destructive" as const,
          onClick: () => setConfirmDeleteOpen(true),
        },
      ],
    },
  ];

  return (
    <div className={isSubcategory ? "ml-6 border-l pl-4" : ""}>
      <div className="flex items-center justify-between gap-2 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          {hasChildren && !isSubcategory && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 shrink-0 p-0"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? (
                <Icons.ChevronDown className="h-4 w-4" />
              ) : (
                <Icons.ChevronRight className="h-4 w-4" />
              )}
            </Button>
          )}
          {!hasChildren && !isSubcategory && <div className="w-6 shrink-0" />}
          <span
            className={`flex shrink-0 items-center justify-center rounded-md ${
              isSubcategory ? "h-6 w-6" : "h-7 w-7"
            }`}
            style={{
              backgroundColor: category.color ? `${category.color}1F` : "var(--muted)",
              color: category.color ?? "var(--muted-foreground)",
            }}
          >
            <CategoryIcon
              icon={category.icon ?? null}
              fallback={category.name}
              className={isSubcategory ? "h-3 w-3" : "h-3.5 w-3.5"}
            />
          </span>
          <span className={`min-w-0 truncate ${isSubcategory ? "text-sm" : "text-sm font-medium"}`}>
            {category.name}
          </span>
          {activityCount > 0 && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-muted-foreground shrink-0 cursor-default text-xs">
                    ({activityCount})
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t("spending:category.transactionCount", { count: activityCount })}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        {/* Desktop: quick inline actions (Add subcategory + Edit). */}
        <div className="hidden shrink-0 items-center gap-1 sm:flex">
          {!isSubcategory && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onAddSubcategory(category)}
              title={t("spending:category.addSubcategory")}
            >
              <Icons.Plus className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onEdit(category)}
            title={t("spending:category.editCategoryTitle")}
          >
            <Icons.Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDeleteOpen(true)}
            title={t("spending:category.deleteCategoryTitle")}
          >
            <Icons.Trash className="h-4 w-4" />
          </Button>
        </div>

        {/* Mobile: ActionPalette popover triggered from a kebab */}
        <ActionPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          title={category.name}
          groups={paletteGroups}
          align="end"
          trigger={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground h-8 w-8 shrink-0 p-0 sm:hidden"
              aria-label={t("spending:category.categoryActions")}
            >
              <Icons.DotsThreeVertical className="h-4 w-4" />
            </Button>
          }
        />

        <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("spending:category.deleteTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("spending:category.deleteConfirm", { name: category.name })}
                {hasChildren && (
                  <span className="text-destructive mt-2 block font-medium">
                    {t("spending:category.deleteSubcategoriesWarning")}
                  </span>
                )}{" "}
                {t("spending:category.deleteUndoNote")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => onDelete(category)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {t("common:delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {hasChildren && isExpanded && (
        <div className="space-y-0">
          {children.map((child) => (
            <CategoryItem
              key={child.id}
              category={child}
              // eslint-disable-next-line react/no-children-prop
              children={child.children}
              onEdit={onEdit}
              onDelete={onDelete}
              onAddSubcategory={onAddSubcategory}
              isSubcategory
              activityCounts={activityCounts}
            />
          ))}
        </div>
      )}
    </div>
  );
}
