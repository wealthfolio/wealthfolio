import type { CgtReport, HoldingParcel } from "./cgt-engine";

export function holdingKeyForParcel(parcel: Pick<HoldingParcel, "symbol" | "account"> | undefined) {
  return parcel ? `${parcel.symbol}:${parcel.account}` : "";
}

export function findParcelContext(
  parcelId: string,
  parcels: HoldingParcel[],
  report: CgtReport,
) {
  return (
    parcels.find((parcel) => parcel.parcelId === parcelId) ??
    report.closedLots.find((lot) => lot.parcelId === parcelId)
  );
}

export function findOpenParcelContext(parcelId: string, parcels: HoldingParcel[]) {
  return parcels.find((parcel) => parcel.parcelId === parcelId && parcel.quantity > 0);
}

function sortParcelOptions(parcels: HoldingParcel[]): HoldingParcel[] {
  return [...parcels].sort((a, b) =>
    `${a.symbol}:${a.account}:${a.parcelId}`.localeCompare(
      `${b.symbol}:${b.account}:${b.parcelId}`,
    ),
  );
}

export function buildAllParcelOptions(
  parcels: HoldingParcel[],
  report: CgtReport,
): HoldingParcel[] {
  const byId = new Map<string, HoldingParcel>();
  for (const parcel of parcels) {
    byId.set(parcel.parcelId, parcel);
  }
  for (const lot of report.closedLots) {
    if (!byId.has(lot.parcelId)) {
      byId.set(lot.parcelId, {
        parcelId: lot.parcelId,
        symbol: lot.symbol,
        account: lot.account,
        acquisitionDate: lot.acquisitionDate,
        quantity: lot.quantity,
        costBase: lot.costBase,
      });
    }
  }
  return sortParcelOptions([...byId.values()]);
}

export function buildOpenParcelOptions(parcels: HoldingParcel[]): HoldingParcel[] {
  return sortParcelOptions(parcels.filter((parcel) => parcel.quantity > 0));
}
