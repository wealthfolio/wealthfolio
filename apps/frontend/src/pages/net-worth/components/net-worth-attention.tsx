import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ResponsiveSelect } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useAlternativeHoldings, useLinkLiability } from "@/hooks/use-alternative-assets";
import {
  AlternativeAssetKind,
  type AlternativeAssetHolding,
  type StaleAssetInfo,
} from "@/lib/types";
import { AlternativeAssetQuickAddModal } from "@/pages/asset/alternative-assets/components/alternative-asset-quick-add-modal";

const ADD_PROPERTY_OPTION = "__add_property__";

interface NetWorthAttentionCardProps {
  staleAssets: StaleAssetInfo[];
  holdings: AlternativeAssetHolding[];
  isLinking?: boolean;
  onLink: (liabilityId: string, propertyId: string) => void;
  onAddProperty: (liabilityId: string) => void;
}

export function NetWorthAttentionCard({
  staleAssets,
  holdings,
  isLinking,
  onLink,
  onAddProperty,
}: NetWorthAttentionCardProps) {
  const { t } = useTranslation();
  const properties = holdings.filter((holding) => holding.kind.toLowerCase() === "property");
  // Older quick-add records can lack a type even when the form displayed Mortgage.
  // Offer the optional property action for those records without inferring their type.
  const unlinkedLiabilities = holdings.filter(
    (holding) =>
      holding.kind.toLowerCase() === "liability" &&
      (!holding.metadata?.sub_type || holding.metadata.sub_type === "mortgage") &&
      !holding.linkedAssetId,
  );
  if (!staleAssets.length && !unlinkedLiabilities.length) return null;

  return (
    <section
      className="border-warning/10 bg-warning/10 rounded-xl border p-4 backdrop-blur-xl md:p-5"
      aria-label={t("insights:networth.attention.title")}
    >
      <div className="flex items-center gap-2">
        <Icons.AlertCircle className="text-warning h-4 w-4 shrink-0" />
        <h3 className="text-foreground text-sm font-semibold">
          {t("insights:networth.attention.title")}
        </h3>
      </div>
      {staleAssets.length > 0 && (
        <div className="ml-6 mt-3">
          <p className="text-muted-foreground text-xs">
            {t("insights:networth.not_updated_over_90_days")}
          </p>
          <div className="mt-2 space-y-1.5">
            {staleAssets.map((asset) => {
              const isLiability =
                holdings.find((holding) => holding.id === asset.assetId)?.kind.toLowerCase() ===
                "liability";
              return (
                <Link
                  key={asset.assetId}
                  to={`/holdings/${encodeURIComponent(asset.assetId)}?tab=history`}
                  className="hover:bg-warning/10 -mx-2 block rounded-md px-2 py-1.5 transition-colors"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 break-words text-xs font-medium">
                      {asset.name ?? asset.assetId}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {t("insights:networth.days_ago", { count: asset.daysStale })}
                    </span>
                  </span>
                  <span className="text-muted-foreground mt-1 block text-xs underline underline-offset-4">
                    {t(
                      isLiability
                        ? "insights:networth.attention.update_balance"
                        : "insights:networth.attention.update_value",
                    )}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
      {unlinkedLiabilities.map((liability) => (
        <div key={liability.id} className="ml-6 mt-3 min-w-0">
          {properties.length > 0 ? (
            <ResponsiveSelect
              value=""
              disabled={isLinking}
              options={[
                ...properties.map((property) => ({ value: property.id, label: property.name })),
                {
                  value: ADD_PROPERTY_OPTION,
                  label: t("insights:networth.attention.add_property", { name: liability.name }),
                },
              ]}
              onValueChange={(propertyId) => {
                if (propertyId === ADD_PROPERTY_OPTION) onAddProperty(liability.id);
                else onLink(liability.id, propertyId);
              }}
              placeholder={t("insights:networth.attention.link_property", { name: liability.name })}
              sheetTitle={t("insights:networth.attention.link_property", { name: liability.name })}
              sheetDescription={t("insights:networth.attention.link_explanation")}
              triggerClassName="h-auto border-0 bg-transparent p-0 text-xs underline underline-offset-4 shadow-none"
            />
          ) : (
            <Button
              variant="link"
              size="sm"
              className="h-auto max-w-full p-0 text-left text-xs underline underline-offset-4"
              disabled={isLinking}
              onClick={() => onAddProperty(liability.id)}
            >
              <span className="truncate">
                {t("insights:networth.attention.add_property", { name: liability.name })}
              </span>
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}

export function NetWorthAttention({ staleAssets }: { staleAssets: StaleAssetInfo[] }) {
  const { data: holdings = [], isError } = useAlternativeHoldings();
  const linkLiability = useLinkLiability();
  const [liabilityId, setLiabilityId] = useState<string | null>(null);
  return (
    <>
      <NetWorthAttentionCard
        staleAssets={staleAssets}
        holdings={isError ? [] : holdings}
        isLinking={linkLiability.isPending}
        onLink={(liabilityId, targetAssetId) =>
          linkLiability.mutate({ liabilityId, targetAssetId })
        }
        onAddProperty={setLiabilityId}
      />
      {liabilityId && (
        <AlternativeAssetQuickAddModal
          open
          onOpenChange={(open) => {
            if (!open) setLiabilityId(null);
          }}
          defaultKind={AlternativeAssetKind.PROPERTY}
          allowKindChange={false}
          onAssetCreated={({ assetId }) =>
            linkLiability.mutate({ liabilityId, targetAssetId: assetId })
          }
        />
      )}
    </>
  );
}
