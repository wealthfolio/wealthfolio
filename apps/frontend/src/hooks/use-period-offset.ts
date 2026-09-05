import { useCallback, useEffect, useMemo, useState } from "react";
import { PERIOD_STEP, shiftPeriodAnchor, type TimePeriod } from "@wealthfolio/ui";

/**
 * Drives the "page back/forward through periods" arrows shared by the
 * Investments and Net Worth dashboards. Tracks how many windows back from
 * "now" the user has paged for the given period `code`, resetting to the
 * current window whenever `code` changes (picking a new period pill).
 */
export function usePeriodOffset(code: TimePeriod) {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setOffset(0);
  }, [code]);

  const anchor = useMemo(() => shiftPeriodAnchor(code, offset), [code, offset]);
  // Periods like "All time" have no meaningful prior window.
  const canStepBackward = PERIOD_STEP[code] !== null;

  const stepBackward = useCallback(() => {
    if (canStepBackward) setOffset((prev) => prev + 1);
  }, [canStepBackward]);
  const stepForward = useCallback(() => setOffset((prev) => Math.max(0, prev - 1)), []);

  return {
    offset,
    anchor,
    canStepBackward,
    canStepForward: offset > 0,
    stepBackward,
    stepForward,
  };
}
