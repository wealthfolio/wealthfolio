import { ExternalLink } from "@/components/external-link";
import { Alert, AlertDescription, AlertTitle } from "@wealthfolio/ui/components/ui/alert";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui/components/ui/sheet";
import type { ActivityDetails } from "@/lib/types";
import { restrictionAllowsType } from "@/lib/activity-restrictions";
import { isLiabilityAccountType } from "@/lib/constants";
import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ActivityTypePicker } from "./activity-type-picker";
import { ActivityFormRenderer } from "./activity-form-renderer";
import type { AccountSelectOption } from "./forms/fields";
import { useActivityForm } from "../hooks/use-activity-form";
import { mapActivityTypeToPicker } from "../utils/activity-form-utils";
import type { PickerActivityType } from "../config/activity-form-config";

// Re-export for consumers
export type { AccountSelectOption };

function transferAllowsAccount(account: AccountSelectOption): boolean {
  return (
    restrictionAllowsType(account.restrictionLevel, "TRANSFER") ||
    isLiabilityAccountType(account.accountType)
  );
}

interface ActivityFormProps {
  accounts: AccountSelectOption[];
  /**
   * Full active-account list for the Transfer form's From/To selectors. Unlike
   * `accounts` (which the Spending split may narrow to investment accounts), a
   * transfer can target any account, so its counterparties are drawn from this.
   */
  transferAccounts?: AccountSelectOption[];
  activity?: Partial<ActivityDetails>;
  open?: boolean;
  onClose?: () => void;
  /** When true, hides the activity type picker (use when type is already determined) */
  hidePicker?: boolean;
}

export function ActivityForm({
  accounts,
  transferAccounts,
  activity,
  open,
  onClose,
  hidePicker,
}: ActivityFormProps) {
  const { t } = useTranslation();
  // Derive the editing state and initial type from activity prop
  const isEditing = !!activity?.id;
  const initialType = mapActivityTypeToPicker(activity?.activityType);

  // Local state for selected type (only used when creating new activity)
  const [selectedType, setSelectedType] = useState<PickerActivityType | undefined>(initialType);

  // For editing, always use the activity's type; for new, use local state
  const effectiveSelectedType = isEditing ? initialType : selectedType;

  // Filter accounts by selected activity type (exclude HOLDINGS accounts for unsupported types).
  // Transfers use the full account list so spending/saving accounts are valid counterparties.
  const filteredAccounts = useMemo(() => {
    const base =
      effectiveSelectedType === "TRANSFER" && transferAccounts ? transferAccounts : accounts;
    if (!effectiveSelectedType) return base;
    if (effectiveSelectedType === "TRANSFER") {
      return base.filter(transferAllowsAccount);
    }
    return base.filter((acc) => restrictionAllowsType(acc.restrictionLevel, effectiveSelectedType));
  }, [accounts, transferAccounts, effectiveSelectedType]);

  // Use the activity form hook with the effective type
  const { defaultValues, isLoading, isError, error, handleSubmit } = useActivityForm({
    accounts: filteredAccounts,
    activity,
    selectedType: effectiveSelectedType,
    onSuccess: onClose,
  });

  // Handle sheet open change - reset state when closing
  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        // Reset selected type when sheet closes
        setSelectedType(undefined);
        onClose?.();
      }
    },
    [onClose],
  );

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        data-testid="activity-form-dialog"
        className="flex w-full flex-col overflow-hidden sm:max-w-[625px]"
      >
        <SheetHeader>
          <SheetTitle>
            {isEditing ? t("activity:mobile_update_activity") : t("activity:add_activity")}
          </SheetTitle>
          <SheetDescription>
            {isEditing
              ? t("activity:update_transaction_desc")
              : t("activity:record_transaction_desc")}{" "}
            <ExternalLink
              href="https://wealthfolio.app/docs/concepts/activity-types"
              className="underline"
            >
              {t("activity:learn_more")}
            </ExternalLink>
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto py-4">
          {/* Activity Type Picker - only show when creating new activity and not locked to a type */}
          {!isEditing && !hidePicker && (
            <ActivityTypePicker value={effectiveSelectedType} onSelect={setSelectedType} />
          )}

          {/* When editing, show the activity type as a badge */}
          {isEditing && effectiveSelectedType && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("activity:activity_type")}:</span>
              <span className="bg-primary/10 text-primary rounded-md px-2 py-1 font-medium">
                {effectiveSelectedType}
              </span>
            </div>
          )}

          {/* Render the appropriate form */}
          <ActivityFormRenderer
            selectedType={effectiveSelectedType}
            accounts={filteredAccounts}
            defaultValues={defaultValues}
            onSubmit={handleSubmit}
            onCancel={onClose}
            isLoading={isLoading}
            isEditing={isEditing}
          />

          {/* Display mutation error inside sheet */}
          {isError && (
            <Alert variant="destructive">
              <Icons.AlertCircle className="h-4 w-4" />
              <AlertTitle>{t("common:error")}</AlertTitle>
              <AlertDescription>{String(error)}</AlertDescription>
            </Alert>
          )}
        </div>

        {/* Footer with Cancel button - only show when no form is selected */}
        {!effectiveSelectedType && (
          <SheetFooter>
            <Button variant="outline" onClick={onClose}>
              {t("common:cancel")}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
