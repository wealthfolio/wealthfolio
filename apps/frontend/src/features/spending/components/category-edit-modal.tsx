import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui";

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
  const { t } = useTranslation();
  const isEditing = !!category;
  const isSubcategory = !!parentCategory;

  const getTitle = () => {
    if (isEditing) return t("spending:category.editTitle");
    if (isSubcategory) return t("spending:category.addSubcategoryTitle");
    return t("spending:category.addTitle");
  };

  const getDescription = () => {
    if (isEditing) return t("spending:category.editDescription");
    if (isSubcategory)
      return t("spending:category.addSubcategoryDescription", { name: parentCategory?.name });
    return t("spending:category.addDescription");
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
