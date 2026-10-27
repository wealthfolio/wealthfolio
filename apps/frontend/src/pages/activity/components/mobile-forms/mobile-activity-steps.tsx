import type { RefObject } from "react";
import { useFormContext } from "react-hook-form";
import type { AccountSelectOption } from "../forms/fields";
import type { NewActivityFormValues } from "../forms/schemas";
import { MobileActivityTypeStep } from "./mobile-activity-type-step";
import { MobileDetailsStep } from "./mobile-details-step";

interface MobileActivityStepsProps {
  currentStep: number;
  accounts: AccountSelectOption[];
  isEditing: boolean;
  /**
   * Editing a row whose stored type has no editor here (sync writes needs-review
   * rows as UNKNOWN). Such a row has to be reclassified first, so it walks the
   * type step before the details step instead of going straight to details.
   */
  needsTypeSelection?: boolean;
  amountWasEdited: RefObject<boolean>;
  onSelectConversion?: () => void;
}

export function MobileActivitySteps({
  currentStep,
  accounts,
  isEditing,
  needsTypeSelection = false,
  amountWasEdited,
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
        amountWasEdited={amountWasEdited}
      />
    );
  }

  return (
    <div className="h-full">
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
          amountWasEdited={amountWasEdited}
        />
      )}
    </div>
  );
}
