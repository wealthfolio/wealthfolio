import { reviewActivitySplitEffects } from "@/adapters";
import type { ActivitySplitEffect, ActivityUpdate } from "@/lib/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

class ActivityEditCancelled extends Error {
  constructor() {
    super("Activity edit cancelled");
    this.name = "ActivityEditCancelled";
  }
}

export const isActivityEditCancelled = (error: unknown) => error instanceof ActivityEditCancelled;

type ReviewEdits = (updates: ActivityUpdate[]) => Promise<ActivityUpdate[]>;
const Context = createContext<ReviewEdits | null>(null);

export function useActivitySplitReview(): ReviewEdits {
  const review = useContext(Context);
  return useCallback(
    (updates) => {
      if (!review) throw new Error("Activity split review provider is missing");
      return review(updates);
    },
    [review],
  );
}

/** Transient confirmation shared by the financial form and grid mutation paths. */
export function ActivitySplitReviewProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [effects, setEffects] = useState<ActivitySplitEffect[] | null>(null);
  const pending = useRef<((approved: boolean) => void) | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.(false);
      pending.current = null;
    };
  }, []);

  const review = useCallback<ReviewEdits>(async (updates) => {
    if (updates.length === 0) return updates;
    if (busy.current) throw new Error("An activity edit is already awaiting review");
    busy.current = true;
    try {
      // Sequential reads keep linked/bulk previews bounded. The writer checks
      // each snapshot again in the existing mutation transaction.
      const reviewed: ActivityUpdate[] = [];
      for (const update of updates) {
        const splitReview = await reviewActivitySplitEffects(update);
        if (!mounted.current) throw new ActivityEditCancelled();
        reviewed.push({ ...update, splitReview });
      }
      const unique = new Map<string, ActivitySplitEffect>();
      for (const update of reviewed) {
        for (const effect of update.splitReview ?? []) unique.set(effect.activityId, effect);
      }
      const destructive = [...unique.values()].filter((effect) => effect.removedSplits > 0);
      if (destructive.length > 0) {
        setEffects(destructive);
        const approved = await new Promise<boolean>((resolve) => {
          pending.current = resolve;
        });
        if (!approved) throw new ActivityEditCancelled();
      }
      return reviewed;
    } finally {
      busy.current = false;
    }
  }, []);

  const finish = (approved: boolean) => {
    pending.current?.(approved);
    pending.current = null;
    setEffects(null);
  };

  return (
    <Context.Provider value={review}>
      {children}
      <AlertDialog open={effects !== null} onOpenChange={(open) => !open && finish(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("spending:splitEditReview.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("spending:splitEditReview.removed", {
                count: effects?.reduce((sum, effect) => sum + effect.removedSplits, 0) ?? 0,
              })}
              {effects?.some((effect) => effect.existingCategoryBecomesEffective) && (
                <> {t("spending:splitEditReview.hiddenCategory")}</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => finish(false)}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => finish(true)}>
              {t("spending:splitEditReview.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Context.Provider>
  );
}
