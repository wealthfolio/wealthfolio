import type { CgtReport } from "../lib/cgt-engine";
import { formatAud } from "../lib/format";

export function SummaryCards({ report }: { report: CgtReport }) {
  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      <div className="rounded-md border p-4">
        <p className="text-muted-foreground text-xs font-medium uppercase">Closed lots</p>
        <p className="mt-2 text-2xl font-semibold">{report.closedLots.length}</p>
      </div>
      <div className="rounded-md border p-4">
        <p className="text-muted-foreground text-xs font-medium uppercase">Proceeds</p>
        <p className="mt-2 text-2xl font-semibold">
          {formatAud(report.incomeYears.reduce((sum, year) => sum + year.proceeds, 0))}
        </p>
      </div>
      <div className="rounded-md border p-4">
        <p className="text-muted-foreground text-xs font-medium uppercase">Gross gains</p>
        <p className="mt-2 text-2xl font-semibold">
          {formatAud(report.incomeYears.reduce((sum, year) => sum + year.grossGain, 0))}
        </p>
      </div>
      <div className="rounded-md border p-4">
        <p className="text-muted-foreground text-xs font-medium uppercase">Losses applied</p>
        <p className="mt-2 text-2xl font-semibold">
          {formatAud(report.incomeYears.reduce((sum, year) => sum + year.capitalLossesApplied, 0))}
        </p>
      </div>
      <div className="rounded-md border p-4">
        <p className="text-muted-foreground text-xs font-medium uppercase">Taxable gains</p>
        <p className="mt-2 text-2xl font-semibold">
          {formatAud(report.incomeYears.reduce((sum, year) => sum + year.taxableGain, 0))}
        </p>
      </div>
    </section>
  );
}
