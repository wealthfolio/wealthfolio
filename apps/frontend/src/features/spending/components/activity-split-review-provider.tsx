import { reviewActivitiesSplitEffects } from "@/adapters";
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

export class ActivityEditCancelled extends Error {
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
    const snapshots = await reviewActivitiesSplitEffects(updates);
    if (!mounted.current) throw new ActivityEditCancelled();
    if (snapshots.length !== updates.length) throw new Error("Incomplete activity split review");
    const reviewed = updates.map((update, index) => ({ ...update, splitReview: snapshots[index] }));
    const unique = new Map<string, ActivitySplitEffect>();
    for (const update of reviewed) {
      for (const effect of update.splitReview ?? []) unique.set(effect.activityId, effect);
    }
    const destructive = [...unique.values()].filter((effect) => effect.removedSplits > 0);
    if (destructive.length > 0) {
      // Ordinary independent saves can preview concurrently. A second
      // destructive review must never overwrite the displayed confirmation.
      if (pending.current) throw new Error("An activity edit is already awaiting confirmation");
      setEffects(destructive);
      const approved = await new Promise<boolean>((resolve) => {
        pending.current = resolve;
      });
      if (!approved) throw new ActivityEditCancelled();
    }
    if (!mounted.current) throw new ActivityEditCancelled();
    return reviewed;
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
              {effects?.some((effect) => effect.hasRetainedCategoryAssignment) && (
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
