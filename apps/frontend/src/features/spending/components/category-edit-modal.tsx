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
  const isEditing = !!category;
  const isSubcategory = !!parentCategory;

  const getTitle = () => {
    if (isEditing) return "Edit Category";
    if (isSubcategory) return "Add Subcategory";
    return "Add Category";
  };

  const getDescription = () => {
    if (isEditing) return "Update the category name and color.";
    if (isSubcategory) return `Add a new subcategory under "${parentCategory?.name}".`;
    return "Create a new category to organize your transactions.";
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
