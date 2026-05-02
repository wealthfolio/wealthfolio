import React from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { formatPercent } from "@wealthfolio/ui";
import { AmountDisplay } from "@wealthfolio/ui";
import { QuantityDisplay } from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";

interface AssetDetail {
  numShares: number;
  marketValue: number;
  costBasis: number;
  averagePrice: number;
  portfolioPercent: number;
  todaysReturn: number | null;
  todaysReturnPercent: number | null;
  totalReturn: number;
  totalReturnPercent: number;
  currency: string;
  quoteCurrency?: string | null;
  quote?: {
    open: number;
    high: number;
    low: number;
    volume: number;
    close: number;
    adjclose: number;
  } | null;
  bondSpec?: {
    maturityDate?: string | null;
    couponRate?: number | null;
    couponFrequency?: string | null;
  } | null;
  optionSpec?: {
    right?: string | null;
    strike?: number | null;
    expiration?: string | null;
  } | null;
  instrumentType?: string | null;
  className?: string;
}

interface AssetDetailProps {
  assetData: AssetDetail;
  className?: string;
}

function quantityLabel(instrumentType?: string | null): string {
  switch (instrumentType) {
    case "BOND":
      return "bonds";
    case "OPTION":
      return "contracts";
    case "METAL":
      return "units";
    default:
      return "shares";
  }
}

const AssetDetailCard: React.FC<AssetDetailProps> = ({ assetData, className }) => {
  const { isBalanceHidden } = useBalancePrivacy();

  const {
    numShares,
    marketValue,
    costBasis,
    averagePrice,
    portfolioPercent,
    todaysReturn,
    todaysReturnPercent,
    totalReturn,
    totalReturnPercent,
    currency,
    quoteCurrency,
    quote,
    bondSpec,
    optionSpec,
  } = assetData;

  const holdingRows = [
    {
      label: "Book value",
      value: <AmountDisplay value={costBasis} currency={currency} isHidden={isBalanceHidden} />,
    },
    {
      label: "Average cost",
      value: <AmountDisplay value={averagePrice} currency={currency} isHidden={isBalanceHidden} />,
    },
    { label: "% of my portfolio", value: formatPercent(portfolioPercent) },
    ...(todaysReturn !== null && todaysReturnPercent !== null
      ? [
          {
            label: "Today's return",
            value: (
              <>
                <AmountDisplay
                  value={todaysReturn}
                  currency={currency}
                  isHidden={isBalanceHidden}
                />{" "}
                ({formatPercent(todaysReturnPercent)})
              </>
            ),
            color: todaysReturn < 0 ? "text-destructive" : "text-success",
          },
        ]
      : []),
    {
      label: "Total return",
      value: (
        <>
          <AmountDisplay value={totalReturn} currency={currency} isHidden={isBalanceHidden} /> (
          {formatPercent(totalReturnPercent)})
        </>
      ),
      color: totalReturn < 0 ? "text-destructive" : "text-success",
    },
  ];

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between pb-0">
        <CardTitle className="flex w-full justify-between text-lg font-bold">
          <div>
            <div>
              <QuantityDisplay value={numShares} isHidden={isBalanceHidden} />
            </div>
            <div className="text-muted-foreground text-sm font-normal">
              {quantityLabel(assetData.instrumentType)}
            </div>
          </div>
          <div>
            <div className="text-xl font-extrabold">
              <AmountDisplay value={marketValue} currency={currency} isHidden={isBalanceHidden} />
            </div>
            <div className="text-muted-foreground text-right text-sm font-normal">{currency}</div>
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent>
        <Separator className="my-3" />
        <div className="space-y-4 text-sm">
          {holdingRows.map(({ label, value, color }, idx) => (
            <div key={idx} className="flex justify-between">
              <span className="text-muted-foreground">{label}</span>
              <span className={`font-medium ${color || ""}`}>{value}</span>
            </div>
          ))}
        </div>

        {quote && (
          <>
            <Separator className="my-4" />
            <div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                <div className="flex flex-col">
                  <span className="text-muted-foreground text-xs">Open</span>
                  <div className="text-sm font-medium">
                    <AmountDisplay
                      value={quote.open}
                      currency={quoteCurrency ?? currency}
                      isHidden={isBalanceHidden}
                    />
                  </div>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-muted-foreground text-xs">Close</span>
                  <div className="text-sm font-medium">
                    <AmountDisplay
                      value={quote.close}
                      currency={quoteCurrency ?? currency}
                      isHidden={isBalanceHidden}
                    />
                  </div>
                </div>
                <div className="flex flex-col">
                  <span className="text-muted-foreground text-xs">High</span>
                  <div className="text-success text-sm font-medium">
                    <AmountDisplay
                      value={quote.high}
                      currency={quoteCurrency ?? currency}
                      isHidden={isBalanceHidden}
                    />
                  </div>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-muted-foreground text-xs">Low</span>
                  <div className="text-destructive text-sm font-medium">
                    <AmountDisplay
                      value={quote.low}
                      currency={quoteCurrency ?? currency}
                      isHidden={isBalanceHidden}
                    />
                  </div>
                </div>
                <div className="flex flex-col">
                  <span className="text-muted-foreground text-xs">Adj Close</span>
                  <div className="text-sm font-medium">
                    <AmountDisplay
                      value={quote.adjclose}
                      currency={quoteCurrency ?? currency}
                      isHidden={isBalanceHidden}
                    />
                  </div>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-muted-foreground text-xs">Volume</span>
                  <span className="text-sm font-medium">
                    {new Intl.NumberFormat().format(quote.volume)}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}

        {bondSpec && (
          <>
            <Separator className="my-4" />
            <div className="grid grid-cols-2 gap-x-6">
              {bondSpec.couponRate != null && (
                <div className="flex flex-col">
                  <span className="text-muted-foreground text-xs">Coupon</span>
                  <span className="text-sm font-medium">
                    {bondSpec.couponFrequency === "ZERO"
                      ? "Zero coupon"
                      : `${(bondSpec.couponRate * 100).toFixed(3)}%`}
                    {bondSpec.couponFrequency &&
                      bondSpec.couponFrequency !== "ZERO" &&
                      ` ${bondSpec.couponFrequency.replace("_", " ").toLowerCase()}`}
                  </span>
                </div>
              )}
              {bondSpec.maturityDate && (
                <div className="flex flex-col items-end">
                  <span className="text-muted-foreground text-xs">Maturity</span>
                  <span className="text-sm font-medium">
                    {new Date(bondSpec.maturityDate + "T00:00:00").toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </div>
              )}
            </div>
          </>
        )}

        {optionSpec && (
          <>
            <Separator className="my-4" />
            <div className="grid grid-cols-3 gap-x-4">
              {optionSpec.right && (
                <div className="flex flex-col">
                  <span className="text-muted-foreground text-xs">Type</span>
                  <span className="text-sm font-medium">{optionSpec.right}</span>
                </div>
              )}
              {optionSpec.strike != null && (
                <div className="flex flex-col">
                  <span className="text-muted-foreground text-xs">Strike</span>
                  <div className="text-sm font-medium">
                    <AmountDisplay
                      value={optionSpec.strike}
                      currency={quoteCurrency ?? currency}
                      isHidden={isBalanceHidden}
                    />
                  </div>
                </div>
              )}
              {optionSpec.expiration && (
                <div className="flex flex-col items-end">
                  <span className="text-muted-foreground text-xs">Expiry</span>
                  <span className="text-sm font-medium">
                    {new Date(optionSpec.expiration + "T00:00:00").toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default AssetDetailCard;
