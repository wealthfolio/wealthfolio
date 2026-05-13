import type { CgtReport } from "../lib/cgt-engine";
import { formatAud } from "../lib/format";

export function DividendFrankingTable({ report }: { report: CgtReport }) {
  return (
    <section className="rounded-md border">
      <div className="border-b p-4">
        <h2 className="text-base font-semibold">Dividend Franking Metadata</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Symbol</th>
              <th className="px-4 py-3 font-medium">Income year</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
              <th className="px-4 py-3 text-right font-medium">Franking percent</th>
              <th className="px-4 py-3 text-right font-medium">Franked amount</th>
            </tr>
          </thead>
          <tbody>
            {report.dividends.map((dividend) => (
              <tr key={dividend.activityId} className="border-t">
                <td className="px-4 py-3">{dividend.symbol}</td>
                <td className="px-4 py-3">{dividend.incomeYear}</td>
                <td className="px-4 py-3 text-right">{formatAud(dividend.amount)}</td>
                <td className="px-4 py-3 text-right">
                  {dividend.frankingPercentage === null
                    ? "Missing"
                    : `${dividend.frankingPercentage}%`}
                </td>
                <td className="px-4 py-3 text-right">
                  {dividend.frankedAmount === null ? "Missing" : formatAud(dividend.frankedAmount)}
                </td>
              </tr>
            ))}
            {report.dividends.length === 0 ? (
              <tr>
                <td className="text-muted-foreground px-4 py-8 text-center" colSpan={5}>
                  No dividend activities with franking metadata found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
