import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Badge, Card, CardContent, CardHeader, CardTitle, Skeleton } from "@wealthfolio/ui";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsContext } from "@/lib/settings-provider";
import { CompactToolCard } from "./shared";

// ============================================================================
// Types
// ============================================================================

interface GetAccountsArgs {
  displayMode?: "compact" | "full";
}

interface AccountDto {
  id: string;
  name: string;
  accountType: string;
  currency: string;
  isActive: boolean;
}

interface GetAccountsResult {
  accounts: AccountDto[];
  count: number;
  truncated?: boolean;
  originalCount?: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Safely converts an unknown value to a string.
 * Returns the fallback if the value is null, undefined, or not a primitive.
 */
function safeString(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

/**
 * Normalizes the result to handle both wrapped and unwrapped formats.
 * The backend may return data in different shapes depending on the context.
 */
function normalizeResult(result: unknown, fallbackCurrency: string): GetAccountsResult | null {
  if (!result) {
    return null;
  }

  // Handle string (JSON) format
  if (typeof result === "string") {
    try {
      return normalizeResult(JSON.parse(result), fallbackCurrency);
    } catch {
      return null;
    }
  }

  if (typeof result !== "object" || result === null) {
    return null;
  }

  const candidate = result as Record<string, unknown>;

  // Handle wrapped format: { data: { accounts: [...] }, meta: {...} }
  if ("data" in candidate && typeof candidate.data === "object" && candidate.data !== null) {
    const data = candidate.data as Record<string, unknown>;
    if (Array.isArray(data.accounts)) {
      return normalizeAccountsResult(data, fallbackCurrency);
    }
  }

  // Handle direct format: { accounts: [...], count: ... }
  if (Array.isArray(candidate.accounts)) {
    return normalizeAccountsResult(candidate, fallbackCurrency);
  }

  return null;
}

/**
 * Normalizes a candidate object with accounts array to GetAccountsResult.
 */
function normalizeAccountsResult(
  candidate: Record<string, unknown>,
  fallbackCurrency: string,
): GetAccountsResult {
  const accountsRaw = candidate.accounts as unknown[];

  const accounts: AccountDto[] = accountsRaw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      id: safeString(item.id ?? item.Id, ""),
      name: safeString(item.name ?? item.Name, "Unknown"),
      accountType: safeString(item.accountType ?? item.account_type ?? item.AccountType, "Unknown"),
      currency: safeString(item.currency ?? item.Currency, fallbackCurrency),
      isActive: Boolean(item.isActive ?? item.is_active ?? item.IsActive ?? true),
    }));

  return {
    accounts,
    count: typeof candidate.count === "number" ? candidate.count : accounts.length,
    truncated: candidate.truncated === true,
    originalCount:
      typeof candidate.originalCount === "number"
        ? candidate.originalCount
        : typeof candidate.original_count === "number"
          ? candidate.original_count
          : undefined,
  };
}

/**
 * Formats account type for display.
 */
function formatAccountType(accountType: string): string {
  return accountType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ============================================================================
// Components
// ============================================================================

function AccountsLoadingSkeleton() {
  return (
    <Card className="bg-muted/40 border-primary/10">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-16" />
        </div>
      </CardHeader>
      <CardContent className="max-h-[320px] space-y-2 overflow-y-auto">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="bg-background/60 flex items-center justify-between rounded-lg border p-3"
          >
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-5 w-12" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function AccountCard({ account }: { account: AccountDto }) {
  return (
    <div className="bg-background/60 hover:bg-background/80 flex items-center justify-between rounded-lg border p-3 transition-colors">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium leading-tight">{account.name}</span>
        <span className="text-muted-foreground text-xs">
          {formatAccountType(account.accountType)}
        </span>
      </div>
      <Badge variant="secondary" className="text-xs uppercase">
        {account.currency}
      </Badge>
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <Card className="bg-muted/40 border-primary/10">
      <CardContent className="flex flex-col items-center justify-center py-8 text-center">
        <p className="text-muted-foreground text-sm">{t("ai:accounts.empty")}</p>
        <p className="text-muted-foreground mt-1 text-xs">{t("ai:accounts.emptyHint")}</p>
      </CardContent>
    </Card>
  );
}

function ErrorState({ message }: { message?: string }) {
  const { t } = useTranslation();
  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardContent className="py-4">
        <p className="text-destructive text-sm font-medium">{t("ai:accounts.error")}</p>
        {message && <p className="text-muted-foreground mt-1 text-xs">{message}</p>}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Main Component
// ============================================================================

type AccountsToolUIContentProps = ToolCallMessagePartProps<GetAccountsArgs, GetAccountsResult>;

function AccountsToolUIContentImpl({ args, result, status }: AccountsToolUIContentProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const parsed = useMemo(() => normalizeResult(result, baseCurrency), [baseCurrency, result]);

  // Group accounts by currency for the summary - must be before early returns
  const currencySummary = useMemo(() => {
    if (!parsed || parsed.accounts.length === 0) return "";
    const byCurrency = new Map<string, number>();
    for (const account of parsed.accounts) {
      byCurrency.set(account.currency, (byCurrency.get(account.currency) ?? 0) + 1);
    }
    return Array.from(byCurrency.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([currency, cnt]) => t("ai:accounts.currencyCount", { count: cnt, currency }))
      .join(", ");
  }, [parsed, t]);

  const isLoading = status?.type === "running";
  const isIncomplete = status?.type === "incomplete";

  // Compact mode — just show a one-liner when used as a prerequisite
  if (args?.displayMode === "compact" && parsed && !isLoading) {
    return <CompactToolCard label={t("ai:accounts.fetched", { count: parsed.accounts.length })} />;
  }

  // Show loading skeleton while running
  if (isLoading) {
    return <AccountsLoadingSkeleton />;
  }

  // Show error state for incomplete/failed status
  if (isIncomplete) {
    return <ErrorState message={t("ai:performance.interrupted")} />;
  }

  // Show empty state if no accounts
  if (!parsed || parsed.accounts.length === 0) {
    return <EmptyState />;
  }

  const { accounts, count, truncated, originalCount } = parsed;

  return (
    <Card className="bg-muted/40 border-primary/10">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{t("ai:accounts.title")}</CardTitle>
            <Badge variant="secondary" className="text-xs">
              {t("ai:accounts.count", { count })}
            </Badge>
            {truncated && originalCount && (
              <Badge variant="outline" className="text-muted-foreground text-xs">
                {t("ai:accounts.of", { count: originalCount })}
              </Badge>
            )}
          </div>
          {currencySummary && (
            <span className="text-muted-foreground text-xs">{currencySummary}</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="max-h-[320px] space-y-2 overflow-y-auto">
        {accounts.map((account) => (
          <AccountCard key={account.id} account={account} />
        ))}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Export
// ============================================================================

const AccountsToolUIContent = memo(AccountsToolUIContentImpl);

export const AccountsToolUI = makeAssistantToolUI<GetAccountsArgs, GetAccountsResult>({
  toolName: "get_accounts",
  render: (props) => {
    return <AccountsToolUIContent {...props} />;
  },
});
