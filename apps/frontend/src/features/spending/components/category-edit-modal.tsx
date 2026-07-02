import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui";
import { useI18n } from "@/i18n/i18n-provider";

import { CategoryForm, type CategoryFormValues } from "./category-form";
import type { CategoryNode } from "./category-item";

interface CategoryEditModalProps {
  open: boolean;
  onClose: () => void;
  category?: CategoryNode;
  parentCategory?: CategoryNode;
  onSave: (values: CategoryFormValues) => void;
  isLoading?: boolean;
}

export function CategoryEditModal({
  open,
  onClose,
  category,
  parentCategory,
  onSave,
  isLoading,
}: CategoryEditModalProps) {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const isEditing = !!category;
  const isSubcategory = !!parentCategory;

  const getTitle = () => {
    if (isEditing) return isChinese ? "编辑分类" : "Edit Category";
    if (isSubcategory) return isChinese ? "添加子分类" : "Add Subcategory";
    return isChinese ? "添加分类" : "Add Category";
  };

  const getDescription = () => {
    if (isEditing) {
      return isChinese ? "更新分类名称和颜色。" : "Update the category name and color.";
    }
    if (isSubcategory) {
      return isChinese
        ? `在“${parentCategory?.name}”下添加新的子分类。`
        : `Add a new subcategory under "${parentCategory?.name}".`;
    }
    return isChinese
      ? "创建一个新分类来整理交易。"
      : "Create a new category to organize your transactions.";
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{getTitle()}</DialogTitle>
          <DialogDescription>{getDescription()}</DialogDescription>
        </DialogHeader>
        <CategoryForm
          category={category}
          parentCategory={parentCategory}
          onSubmit={onSave}
          onCancel={onClose}
          isLoading={isLoading}
        />
      </DialogContent>
    </Dialog>
  );
}
