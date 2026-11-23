import { useCallback, useRef } from "react";
import { useHapticFeedback } from "./use-haptic-feedback";

const CHART_SCRUB_HAPTIC_INTERVAL_MS = 80;

/**
 * A selection tick each time a finger scrubbing a chart reaches a new data point,
 * at most once every 80 ms. Call `reset` when the finger lifts.
 */
export function useChartScrubHaptic() {
  const { triggerHaptic } = useHapticFeedback();
  const lastLabelRef = useRef<string | number | undefined>(undefined);
  const lastAtRef = useRef(0);

  const tick = useCallback(
    (label: string | number | null | undefined) => {
      if (label == null || label === lastLabelRef.current) {
        return;
      }

      const now = Date.now();
      if (now - lastAtRef.current < CHART_SCRUB_HAPTIC_INTERVAL_MS) {
        return;
      }

      lastLabelRef.current = label;
      lastAtRef.current = now;
      triggerHaptic();
    },
    [triggerHaptic],
  );

  const reset = useCallback(() => {
    lastLabelRef.current = undefined;
  }, []);

  return { tick, reset };
}
