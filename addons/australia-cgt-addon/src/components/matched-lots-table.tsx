import type { CgtReport } from "../lib/cgt-engine";
import { formatAud } from "../lib/format";

export function MatchedLotsTable({ report }: { report: CgtReport }) {
  return (
    <section className="rounded-md border">
      <div className="border-b p-4">
        <h2 className="text-base font-semibold">Matched Lots</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Symbol</th>
              <th className="px-4 py-3 font-medium">Account</th>
              <th className="px-4 py-3 text-right font-medium">Quantity</th>
              <th className="px-4 py-3 font-medium">Acquired</th>
              <th className="px-4 py-3 font-medium">Disposed</th>
              <th className="px-4 py-3 text-right font-medium">AMIT adj.</th>
              <th className="px-4 py-3 text-right font-medium">Gain</th>
              <th className="px-4 py-3 text-right font-medium">Pre-loss discount</th>
              <th className="px-4 py-3 text-right font-medium">Pre-loss taxable</th>
            </tr>
          </thead>
          <tbody>
            {report.closedLots.map((lot, index) => (
              <tr
                key={`${lot.symbol}-${lot.acquisitionDate}-${lot.disposalDate}-${index}`}
                className="border-t"
              >
                <td className="px-4 py-3 font-medium">{lot.symbol}</td>
                <td className="px-4 py-3">{lot.account}</td>
                <td className="px-4 py-3 text-right">{lot.quantity}</td>
                <td className="px-4 py-3">{lot.acquisitionDate}</td>
                <td className="px-4 py-3">{lot.disposalDate}</td>
                <td className="px-4 py-3 text-right">{formatAud(lot.amitCostBaseAdjustment)}</td>
                <td
                  className={
                    lot.grossGain < 0 ? "px-4 py-3 text-right text-red-600" : "px-4 py-3 text-right"
                  }
                >
                  {formatAud(lot.grossGain)}
                </td>
                <td className="px-4 py-3 text-right">{formatAud(lot.preLossDiscountEstimate)}</td>
                <td className="px-4 py-3 text-right">
                  {formatAud(lot.preLossTaxableGainEstimate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
