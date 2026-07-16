import { useTranslation } from "react-i18next";
import type { AccountSelectOption } from "./forms/fields";
import {
  ACTIVITY_FORM_CONFIG,
  type ActivityFormValues,
  type PickerActivityType,
} from "../config/activity-form-config";

interface ActivityFormRendererProps {
  selectedType: PickerActivityType | undefined;
  accounts: AccountSelectOption[];
  defaultValues: Partial<ActivityFormValues> | undefined;
  onSubmit: (data: ActivityFormValues) => void | Promise<void>;
  onCancel?: () => void;
  isLoading?: boolean;
  isEditing?: boolean;
}

/**
 * Renders the appropriate form component based on selected activity type.
 * Uses strategy pattern - form component is looked up from config.
 */
export function ActivityFormRenderer({
  selectedType,
  accounts,
  defaultValues,
  onSubmit,
  onCancel,
  isLoading,
  isEditing,
}: ActivityFormRendererProps) {
  const { t } = useTranslation();
  if (!selectedType) {
    return (
      <div className="text-muted-foreground flex h-40 items-center justify-center">
        {t("activity:form_renderer.select_type")}
      </div>
    );
  }

  const config = ACTIVITY_FORM_CONFIG[selectedType];
  if (!config) {
    return (
      <div className="text-muted-foreground flex h-40 items-center justify-center text-center text-sm">
        {t("activity:form_renderer.not_editable")}
      </div>
    );
  }

  const FormComponent = config.component;
  const defaultAccountId = (defaultValues as { accountId?: string } | undefined)?.accountId ?? "";
  const defaultCurrency = (defaultValues as { currency?: string } | undefined)?.currency ?? "";
  const accountSignature = accounts
    .map((account) => `${account.value}:${account.currency}`)
    .join("|");
  const formKey = `${selectedType}:${defaultAccountId}:${defaultCurrency}:${accountSignature}`;

  // Key forces re-mount when form identity changes (type/account defaults/accounts list).
  return (
    <FormComponent
      key={formKey}
      accounts={accounts}
      defaultValues={defaultValues}
      onSubmit={onSubmit}
      onCancel={onCancel}
      isLoading={isLoading}
      isEditing={isEditing}
    />
  );
}
