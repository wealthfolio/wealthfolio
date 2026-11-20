import { returnViewExplainer, returnViewName } from "@/components/return-percent";
import { useReturnMethod } from "@/hooks/use-return-method";
import { cn } from "@/lib/utils";
import type { ChosenReturnView } from "@/lib/performance";
import { RadioGroup, RadioGroupItem } from "@wealthfolio/ui";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { useTranslation } from "react-i18next";

const RETURN_VIEWS: ChosenReturnView[] = ["twr", "moneyWeighted"];

/** The return method shown on the Dashboard, accounts, Performance and the assistant. */
export function ReturnMethodSettings() {
  const { t } = useTranslation();
  const { returnView, setReturnView } = useReturnMethod();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("settings:return_method_title")}</CardTitle>
        <CardDescription>{t("settings:return_method_description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <RadioGroup
          value={returnView}
          onValueChange={(value) => setReturnView(value as ChosenReturnView)}
          aria-label={t("settings:return_method_title")}
          className="grid gap-3 sm:grid-cols-2"
        >
          {RETURN_VIEWS.map((view) => (
            <label
              key={view}
              data-testid={`return-method-${view}`}
              className={cn(
                "hover:bg-accent/50 bg-card dark:bg-muted/20 dark:hover:bg-muted/30 relative flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors",
                returnView === view
                  ? "border-primary bg-primary/5 dark:border-foreground/60 dark:bg-secondary/30"
                  : "border-border",
              )}
            >
              <RadioGroupItem value={view} className="mt-0.5" />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{returnViewName(view, t)}</span>
                <span className="text-muted-foreground text-xs">
                  {returnViewExplainer(view, t)}
                </span>
              </div>
            </label>
          ))}
        </RadioGroup>
      </CardContent>
    </Card>
  );
}
