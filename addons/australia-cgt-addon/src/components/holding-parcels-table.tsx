import type { HoldingParcel } from "../lib/cgt-engine";
import { formatAud } from "../lib/format";

interface HoldingParcelsTableProps {
  holdingParcels: HoldingParcel[];
  isLoading: boolean;
}

export function HoldingParcelsTable({ holdingParcels, isLoading }: HoldingParcelsTableProps) {
  return (
    <section className="rounded-md border">
      <div className="border-b p-4">
        <h2 className="text-base font-semibold">Holding Parcels</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Parcel</th>
              <th className="px-4 py-3 font-medium">Symbol</th>
              <th className="px-4 py-3 font-medium">Acquired</th>
              <th className="px-4 py-3 text-right font-medium">Quantity</th>
              <th className="px-4 py-3 text-right font-medium">Cost base</th>
            </tr>
          </thead>
          <tbody>
            {holdingParcels.map((parcel) => (
              <tr key={parcel.parcelId} className="border-t">
                <td className="px-4 py-3">{parcel.parcelId}</td>
                <td className="px-4 py-3">{parcel.symbol}</td>
                <td className="px-4 py-3">{parcel.acquisitionDate}</td>
                <td className="px-4 py-3 text-right">{parcel.quantity}</td>
                <td className="px-4 py-3 text-right">{formatAud(parcel.costBase)}</td>
              </tr>
            ))}
            {holdingParcels.length === 0 ? (
              <tr>
                <td className="text-muted-foreground px-4 py-8 text-center" colSpan={5}>
                  {isLoading ? "Loading holding parcels..." : "No holdings found."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
