import type { RefObject } from "react";
import type { ActivityDetails } from "@/lib/types";
import { useFormContext } from "react-hook-form";
import type { AccountSelectOption } from "../forms/fields";
import type { NewActivityFormValues } from "../forms/schemas";
import type { IncomeAmountTypedLast } from "../forms/use-income-amounts";
import { MobileActivityTypeStep } from "./mobile-activity-type-step";
import { MobileDetailsStep } from "./mobile-details-step";

interface MobileActivityStepsProps {
  currentStep: number;
  accounts: AccountSelectOption[];
  isEditing: boolean;
  originalActivity?: Partial<ActivityDetails>;
  /**
   * Editing a row whose stored type has no editor here (sync writes needs-review
   * rows as UNKNOWN). Such a row has to be reclassified first, so it walks the
   * type step before the details step instead of going straight to details.
   */
  needsTypeSelection?: boolean;
  amountWasEdited: RefObject<boolean>;
  incomeAmountTypedLast: RefObject<IncomeAmountTypedLast>;
  onSelectConversion?: () => void;
}

export function MobileActivitySteps({
  currentStep,
  accounts,
  isEditing,
  originalActivity,
  needsTypeSelection = false,
  amountWasEdited,
  incomeAmountTypedLast,
  onSelectConversion,
}: MobileActivityStepsProps) {
  const { watch } = useFormContext<NewActivityFormValues>();
  const activityType = watch("activityType");

  if (isEditing && !needsTypeSelection) {
    return (
      <MobileDetailsStep
        activityType={activityType}
        accounts={accounts}
        isEditing
        originalActivity={originalActivity}
        amountWasEdited={amountWasEdited}
        incomeAmountTypedLast={incomeAmountTypedLast}
      />
    );
  }

  return (
    <div>
      {currentStep === 1 && (
        <MobileActivityTypeStep
          includeReclassificationTypes={needsTypeSelection}
          onSelectConversion={onSelectConversion}
        />
      )}
      {currentStep === 2 && activityType && (
        <MobileDetailsStep
          activityType={activityType}
          accounts={accounts}
          isEditing={isEditing}
          originalActivity={originalActivity}
          amountWasEdited={amountWasEdited}
          incomeAmountTypedLast={incomeAmountTypedLast}
        />
      )}
    </div>
  );
}
