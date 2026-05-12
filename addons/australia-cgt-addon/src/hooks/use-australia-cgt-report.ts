import { useQuery } from "@tanstack/react-query";
import type { Account, ActivityDetails, AddonContext, Holding } from "@wealthfolio/addon-sdk";
import { useMemo } from "react";
import { buildCgtReport, buildHoldingParcels } from "../lib/cgt-engine";
import { buildAllParcelOptions, buildOpenParcelOptions } from "../lib/parcel-options";
import type { AustraliaCgtAddonData } from "../lib/tax-data";

export function useAustraliaCgtReport(ctx: AddonContext, taxData: AustraliaCgtAddonData) {
  const activitiesQuery = useQuery<ActivityDetails[]>({
    queryKey: ["australia-cgt", "activities"],
    queryFn: () => ctx.api.activities.getAll(),
    staleTime: 60_000,
  });

  const accountsQuery = useQuery<Account[]>({
    queryKey: ["australia-cgt", "accounts"],
    queryFn: () => ctx.api.accounts.getAll(),
    staleTime: 60_000,
  });

  const holdingsQuery = useQuery<Holding[]>({
    queryKey: ["australia-cgt", "holdings", accountsQuery.data?.map((account) => account.id)],
    enabled: Boolean(accountsQuery.data),
    queryFn: async () => {
      const accounts = accountsQuery.data ?? [];
      const holdings = await Promise.all(
        accounts.map((account) => ctx.api.portfolio.getHoldings(account.id)),
      );
      return holdings.flat();
    },
    staleTime: 60_000,
  });

  const holdingParcels = useMemo(
    () =>
      buildHoldingParcels((holdingsQuery.data ?? []) as Holding[], taxData.acquisitionOverrides),
    [holdingsQuery.data, taxData.acquisitionOverrides],
  );

  const report = useMemo(
    () =>
      buildCgtReport((activitiesQuery.data ?? []) as Parameters<typeof buildCgtReport>[0], {
        amitAdjustments: taxData.amitAdjustments,
        transitionSnapshots: taxData.transitionSnapshots,
        acquisitionOverrides: taxData.acquisitionOverrides,
        holdingParcels,
      }),
    [
      activitiesQuery.data,
      holdingParcels,
      taxData.acquisitionOverrides,
      taxData.amitAdjustments,
      taxData.transitionSnapshots,
    ],
  );

  const allParcelOptions = useMemo(
    () => buildAllParcelOptions(holdingParcels, report),
    [holdingParcels, report],
  );
  const openParcelOptions = useMemo(() => buildOpenParcelOptions(holdingParcels), [holdingParcels]);

  return {
    activitiesQuery,
    holdingsQuery,
    report,
    holdingParcels,
    allParcelOptions,
    openParcelOptions,
  };
}
