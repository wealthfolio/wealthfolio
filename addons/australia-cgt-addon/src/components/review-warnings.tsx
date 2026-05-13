import { Icons } from "@wealthfolio/ui";
import type { CgtReport } from "../lib/cgt-engine";

export function ReviewWarnings({ report }: { report: CgtReport }) {
  return (
    <>
      {report.unmatchedSells.length > 0 ? (
        <section className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <div className="flex items-start gap-3">
            <Icons.AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <h2 className="font-semibold">Unmatched sells need review</h2>
              <p className="mt-1">
                {report.unmatchedSells.length} disposal
                {report.unmatchedSells.length === 1 ? "" : "s"} could not be fully matched to
                earlier buy lots. Totals exclude the unmatched quantity until the missing
                acquisition history is added.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {report.unsupportedActivities.length > 0 ? (
        <section className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-950 dark:border-red-700 dark:bg-red-950 dark:text-red-100">
          <div className="flex items-start gap-3">
            <Icons.AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <h2 className="font-semibold">Non-AUD activities excluded</h2>
              <p className="mt-1">
                {report.unsupportedActivities.length} BUY/SELL activit
                {report.unsupportedActivities.length === 1 ? "y was" : "ies were"} excluded because
                this addon does not convert foreign-currency CGT amounts to AUD yet.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {report.ignoredActivities.length > 0 ? (
        <section className="rounded-md border border-slate-300 bg-slate-50 p-4 text-sm text-slate-950 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
          <div className="flex items-start gap-3">
            <Icons.AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <h2 className="font-semibold">Some activity types are not modelled</h2>
              <p className="mt-1">
                {report.ignoredActivities.length} non-BUY/SELL activit
                {report.ignoredActivities.length === 1 ? "y is" : "ies are"} not included in CGT lot
                matching. Review transfers, splits, and corporate actions manually.
              </p>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
