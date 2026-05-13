import type { CgtReport } from "../lib/cgt-engine";
import { formatAud } from "../lib/format";

export function IncomeYearSummaryTable({ report }: { report: CgtReport }) {
  return (
    <section className="rounded-md border">
      <div className="border-b p-4">
        <h2 className="text-base font-semibold">Income Year Summary</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Final taxable gains are calculated here after same-year and carried-forward capital
          losses.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Income year</th>
              <th className="px-4 py-3 text-right font-medium">Proceeds</th>
              <th className="px-4 py-3 text-right font-medium">Cost base</th>
              <th className="px-4 py-3 text-right font-medium">Gross gain</th>
              <th className="px-4 py-3 text-right font-medium">Losses applied</th>
              <th className="px-4 py-3 text-right font-medium">Loss carry-forward</th>
              <th className="px-4 py-3 text-right font-medium">Discount</th>
              <th className="px-4 py-3 text-right font-medium">Taxable gain</th>
            </tr>
          </thead>
          <tbody>
            {report.incomeYears.map((year) => (
              <tr key={year.incomeYear} className="border-t">
                <td className="px-4 py-3 font-medium">{year.incomeYear}</td>
                <td className="px-4 py-3 text-right">{formatAud(year.proceeds)}</td>
                <td className="px-4 py-3 text-right">{formatAud(year.costBase)}</td>
                <td className="px-4 py-3 text-right">{formatAud(year.grossGain)}</td>
                <td className="px-4 py-3 text-right">{formatAud(year.capitalLossesApplied)}</td>
                <td className="px-4 py-3 text-right">{formatAud(year.capitalLossCarryForward)}</td>
                <td className="px-4 py-3 text-right">{formatAud(year.discountApplied)}</td>
                <td className="px-4 py-3 text-right">{formatAud(year.taxableGain)}</td>
              </tr>
            ))}
            {report.incomeYears.length === 0 ? (
              <tr>
                <td className="text-muted-foreground px-4 py-8 text-center" colSpan={8}>
                  No matched BUY/SELL lots found yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
