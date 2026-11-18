import { logger } from "@/adapters";
import { chosenReturnView, returnMetricForView, type ChosenReturnView } from "@/lib/performance";
import { useSettingsContext } from "@/lib/settings-provider";
import { useCallback } from "react";

/**
 * The return method shown across the app (time-weighted or money-weighted),
 * saved in settings so every screen shows the same one.
 */
export function useReturnMethod(): {
  returnView: ChosenReturnView;
  setReturnView: (view: ChosenReturnView) => void;
} {
  const { settings, updateSettings } = useSettingsContext();
  const returnView = chosenReturnView(settings?.defaultReturnMetric);
  const setReturnView = useCallback(
    (view: ChosenReturnView) => {
      if (view === returnView) return;
      // The settings mutation reports a failed save; the switch stays put.
      const save = async () => {
        try {
          await updateSettings({ defaultReturnMetric: returnMetricForView(view) });
        } catch (error) {
          logger.error(`Failed to save the return method: ${String(error)}`);
        }
      };
      void save();
    },
    [returnView, updateSettings],
  );
  return { returnView, setReturnView };
}
