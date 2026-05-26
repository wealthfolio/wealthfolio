import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui";

import { RuleForm, type RuleFormCategoryOption, type RuleFormValues } from "./rule-form";
import type { CategorizationRule } from "../types/rule";

interface RuleEditModalProps {
  open: boolean;
  onClose: () => void;
  rule?: CategorizationRule;
  categoryOptions: RuleFormCategoryOption[];
  onSave: (values: RuleFormValues) => void;
  isLoading?: boolean;
}

export function RuleEditModal({
  open,
  onClose,
  rule,
  categoryOptions,
  onSave,
  isLoading,
}: RuleEditModalProps) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit Rule" : "Add Rule"}</DialogTitle>
          <DialogDescription>
            Auto-tag activities by name pattern. Higher priority rules win when multiple match.
          </DialogDescription>
        </DialogHeader>
        <RuleForm
          rule={rule}
          categoryOptions={categoryOptions}
          onSubmit={onSave}
          onCancel={onClose}
          isLoading={isLoading}
        />
      </DialogContent>
    </Dialog>
  );
}
