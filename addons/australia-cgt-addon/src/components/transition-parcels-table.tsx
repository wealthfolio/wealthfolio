import type { CgtReport } from "../lib/cgt-engine";
import { formatAud } from "../lib/format";

export function TransitionParcelsTable({ report }: { report: CgtReport }) {
  return (
    <section className="rounded-md border">
      <div className="border-b p-4">
        <h2 className="text-base font-semibold">2027 Transition Parcels</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Parcel</th>
              <th className="px-4 py-3 font-medium">Symbol</th>
              <th className="px-4 py-3 text-right font-medium">Quantity</th>
              <th className="px-4 py-3 text-right font-medium">Cost base</th>
              <th className="px-4 py-3 text-right font-medium">2027 value</th>
              <th className="px-4 py-3 text-right font-medium">Pre-2027 taxable</th>
            </tr>
          </thead>
          <tbody>
            {report.transitionLots.map((lot) => (
              <tr key={lot.parcelId} className="border-t">
                <td className="px-4 py-3">{lot.parcelId}</td>
                <td className="px-4 py-3">{lot.symbol}</td>
                <td className="px-4 py-3 text-right">{lot.quantity}</td>
                <td className="px-4 py-3 text-right">{formatAud(lot.costBase)}</td>
                <td className="px-4 py-3 text-right">{formatAud(lot.marketValueAt2027)}</td>
                <td className="px-4 py-3 text-right">
                  {formatAud(lot.preCommencementTaxableGain)}
                </td>
              </tr>
            ))}
            {report.transitionLots.length === 0 ? (
              <tr>
                <td className="text-muted-foreground px-4 py-8 text-center" colSpan={6}>
                  No 2027 parcel snapshots saved yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
