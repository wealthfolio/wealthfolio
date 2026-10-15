import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNumberFormatting } from "@wealthfolio/ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";

import { simulationReferenceBand } from "../lib/simulation-reference";

const BAND_COLORS = {
  low: "text-destructive",
  middle: "text-amber-700 dark:text-amber-400",
  high: "text-[hsl(102,32%,39%)] dark:text-green-400",
};

export function SimulationPercentage({
  rate,
  plannerMode,
}: {
  rate: number;
  plannerMode: "fire" | "traditional";
}) {
  const { t } = useTranslation();
  const formatting = useNumberFormatting();
  const [open, setOpen] = useState(false);
  const percent = Math.round(rate * 100);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={`rounded-sm underline decoration-dotted underline-offset-4 focus-visible:outline focus-visible:outline-2 ${BAND_COLORS[simulationReferenceBand(rate)]}`}
            onClick={(event) => {
              event.preventDefault();
              setOpen((previous) => !previous);
            }}
          />
        }
      >
        {formatting.formatPercent(percent / 100, { digits: 0 })}
      </TooltipTrigger>
      <TooltipContent
        className="text-xs"
        style={{ maxWidth: "min(22rem, calc(100vw - 2rem))" }}
        collisionPadding={16}
      >
        {t(`goals:risk_lab.results.simulation_tooltip_${plannerMode}`, {
          percent: formatting.formatDecimal(percent),
        })}
      </TooltipContent>
    </Tooltip>
  );
}
