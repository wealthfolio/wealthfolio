import { useTranslation } from "react-i18next";
import { GainAmount, GainPercent } from "@wealthfolio/ui";

interface SpendingDeltaLineProps {
  /** This period's spending minus the prior period's. */
  delta: number;
  currency: string;
  /** The change as a ratio of the prior period's spending, or null to leave it out. */
  deltaPct: number | null;
}

/**
 * The Spending hero's change line: amount | percent | "from prior period", as on
 * Investments and Net Worth, with the colours swapped because less spending is the good
 * direction. Spending up or down is a status, not a gain or loss, so the line pins the
 * gain and loss colours to success and destructive and the Gain and loss colours setting
 * leaves it alone.
 */
export function SpendingDeltaLine({ delta, currency, deltaPct }: SpendingDeltaLineProps) {
  const { t } = useTranslation();

  if (Math.abs(delta) < 1) {
    return (
      <span className="text-muted-foreground lg:text-md text-sm font-light">
        {t("spending:tabContent.aboutSame")}
      </span>
    );
  }

  return (
    // `contents`: the parts stay items of the row the line sits in.
    <div className="contents [--gain:var(--success)] [--loss:var(--destructive)]">
      <GainAmount
        className="lg:text-md text-sm font-light"
        value={delta}
        currency={currency}
        displayCurrency={false}
        invertColor
      />
      {deltaPct !== null && (
        <>
          <div className="border-secondary my-1 self-stretch border-e pe-2" />
          <GainPercent
            className="lg:text-md text-sm font-light"
            value={deltaPct}
            animated={true}
            invertColor
          />
        </>
      )}
      <span className="lg:text-md text-muted-foreground ms-1 text-sm font-light">
        {t("spending:tabContent.fromPriorPeriod")}
      </span>
    </div>
  );
}
