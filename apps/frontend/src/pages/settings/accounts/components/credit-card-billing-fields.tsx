import { useTranslation } from "react-i18next";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { useFormField } from "@wealthfolio/ui/components/ui/form";

interface CreditCardBillingFieldsProps {
  value?: string | null;
  onChange: (value: string) => void;
}

/** Edits the optional billing schedule while preserving unrelated account metadata. */
export function CreditCardBillingFields({ value, onChange }: CreditCardBillingFieldsProps) {
  const { t } = useTranslation();
  const { error, formMessageId } = useFormField();
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(value ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed;
  } catch {
    // Legacy non-object metadata cannot hold account settings.
  }
  const billing = meta.creditCardBilling as { closingDay?: number; dueDay?: number } | null;
  const enabled = billing != null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="card-billing-enabled">{t("account:billing.title")}</Label>
        <Switch
          id="card-billing-enabled"
          checked={enabled}
          onCheckedChange={(checked) => {
            const updated = { ...meta };
            if (checked) updated.creditCardBilling = { closingDay: 1, dueDay: 15 };
            else delete updated.creditCardBilling;
            onChange(JSON.stringify(updated));
          }}
        />
      </div>
      {enabled && (
        <>
          <div className="grid grid-cols-2 gap-3">
            {(["closingDay", "dueDay"] as const).map((key) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={`card-billing-${key}`}>
                  {key === "closingDay"
                    ? t("account:billing.closing_day")
                    : t("account:billing.due_day")}
                </Label>
                <Input
                  id={`card-billing-${key}`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={31}
                  step={1}
                  required
                  value={billing?.[key] ?? ""}
                  aria-invalid={!!error}
                  aria-describedby={
                    error ? `card-billing-hint ${formMessageId}` : "card-billing-hint"
                  }
                  onChange={(event) =>
                    onChange(
                      JSON.stringify({
                        ...meta,
                        creditCardBilling: {
                          ...billing,
                          [key]: event.target.value === "" ? undefined : Number(event.target.value),
                        },
                      }),
                    )
                  }
                />
              </div>
            ))}
          </div>
          <p id="card-billing-hint" className="text-muted-foreground text-xs">
            {t("account:billing.schedule_hint")}
          </p>
        </>
      )}
    </div>
  );
}
