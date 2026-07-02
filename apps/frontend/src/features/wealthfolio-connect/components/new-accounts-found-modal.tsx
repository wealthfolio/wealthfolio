import { useState, useEffect } from "react";
import { ExternalLink } from "@/components/external-link";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui/components/ui/sheet";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import { ScrollArea } from "@wealthfolio/ui/components/ui/scroll-area";
import { updateAccount } from "@/adapters";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Account, TrackingMode } from "@/lib/types";
import { syncBrokerData } from "../services/broker-service";
import { useI18n } from "@/i18n/i18n-provider";

export interface NewAccountInfo {
  localAccountId: string;
  providerAccountId: string;
  defaultName: string;
  currency: string;
  institutionName?: string;
}

interface AccountSetup {
  name: string;
  group: string;
  trackingMode: TrackingMode;
}

interface NewAccountsFoundModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Full account objects from the backend */
  accounts: Account[];
  onComplete?: () => void;
}

export function NewAccountsFoundModal({
  open,
  onOpenChange,
  accounts,
  onComplete,
}: NewAccountsFoundModalProps) {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);

  // Initialize setup state for each account
  const [accountSetups, setAccountSetups] = useState<Record<string, AccountSetup>>({});

  // Reset accountSetups when accounts change
  useEffect(() => {
    const initial: Record<string, AccountSetup> = {};
    accounts.forEach((acc) => {
      initial[acc.id] = {
        name: acc.name,
        group: acc.group ?? "",
        trackingMode: "TRANSACTIONS", // Default selection for new accounts
      };
    });
    setAccountSetups(initial);
  }, [accounts]);

  const updateSetup = (accountId: string, field: keyof AccountSetup, value: string) => {
    setAccountSetups((prev) => ({
      ...prev,
      [accountId]: { ...prev[accountId], [field]: value },
    }));
  };

  const handleSaveAndSync = async () => {
    setIsSaving(true);
    try {
      // Update each account with the chosen settings
      for (const acc of accounts) {
        const setup = accountSetups[acc.id];
        if (!setup) continue;

        // Update account name, group, and tracking mode
        await updateAccount({
          id: acc.id,
          name: setup.name,
          accountType: acc.accountType,
          currency: acc.currency,
          group: setup.group || undefined,
          isDefault: acc.isDefault,
          isActive: acc.isActive,
          isArchived: acc.isArchived,
          trackingMode: setup.trackingMode,
        });
      }

      // Invalidate queries and trigger sync
      await queryClient.invalidateQueries();

      toast.success(isChinese ? "账户已配置" : "Accounts configured", {
        description: isChinese
          ? "正在使用你选择的设置开始同步..."
          : "Starting sync with your selected settings...",
      });

      onOpenChange(false);
      onComplete?.();

      // Trigger broker sync to import data for the now-configured accounts
      syncBrokerData();
    } catch (error) {
      toast.error(isChinese ? "保存账户失败" : "Failed to save accounts", {
        description: String(error),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleNotNow = () => {
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex h-full w-full flex-col p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle className="flex items-center gap-2">
            <Icons.Users className="h-5 w-5" />
            {isChinese ? "发现新账户" : "New accounts found"}
          </SheetTitle>
          <SheetDescription>
            {isChinese
              ? "选择每个账户的跟踪方式。你之后仍可更改。"
              : "Choose how to track each account. You can change this later."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-[calc(100vh-220px)]">
            <div className="space-y-6 p-6">
              <Alert
                variant="warning"
                className="px-3 py-2.5 [&>svg]:left-3 [&>svg]:top-2.5 [&>svg~*]:pl-6"
              >
                <Icons.AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  {isChinese ? (
                    <>
                      <strong>交易</strong>模式会记录每笔交易，用于完整绩效分析。
                      <strong>持仓</strong>模式只导入快照，指标会受限。
                    </>
                  ) : (
                    <>
                      <strong>Transactions</strong> mode tracks every trade for full performance
                      analytics. <strong>Holdings</strong> mode imports snapshots only with limited
                      metrics.
                    </>
                  )}{" "}
                  <ExternalLink
                    href="https://wealthfolio.app/docs/concepts/activity-types"
                    className="hover:text-foreground underline"
                  >
                    {isChinese ? "了解更多" : "Learn more"}
                  </ExternalLink>
                </AlertDescription>
              </Alert>

              {accounts.map((acc) => {
                const setup = accountSetups[acc.id];
                return (
                  <div key={acc.id} className="space-y-4 rounded-lg border p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-medium">{acc.name}</p>
                        <p className="text-muted-foreground text-xs">{acc.currency}</p>
                      </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor={`name-${acc.id}`}>
                          {isChinese ? "账户名称" : "Account name"}
                        </Label>
                        <Input
                          id={`name-${acc.id}`}
                          value={setup?.name ?? ""}
                          onChange={(e) => updateSetup(acc.id, "name", e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`group-${acc.id}`}>
                          {isChinese ? "分组（可选）" : "Group (optional)"}
                        </Label>
                        <Input
                          id={`group-${acc.id}`}
                          value={setup?.group ?? ""}
                          placeholder={isChinese ? "例如：退休账户" : "e.g., Retirement"}
                          onChange={(e) => updateSetup(acc.id, "group", e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>{isChinese ? "跟踪模式" : "Tracking mode"}</Label>
                      <RadioGroup
                        value={setup?.trackingMode}
                        onValueChange={(value) =>
                          updateSetup(acc.id, "trackingMode", value as TrackingMode)
                        }
                        className="grid grid-cols-2 gap-3"
                      >
                        <label
                          className={`hover:bg-accent relative flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${
                            setup?.trackingMode === "TRANSACTIONS"
                              ? "border-primary bg-primary/5"
                              : "border-muted"
                          }`}
                        >
                          <RadioGroupItem value="TRANSACTIONS" className="mt-0.5" />
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">
                              {isChinese ? "交易" : "Transactions"}
                            </span>
                            <span className="text-muted-foreground text-xs">
                              {isChinese ? "完整绩效分析" : "Full performance analytics"}
                            </span>
                          </div>
                        </label>
                        <label
                          className={`hover:bg-accent relative flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${
                            setup?.trackingMode === "HOLDINGS"
                              ? "border-primary bg-primary/5"
                              : "border-muted"
                          }`}
                        >
                          <RadioGroupItem value="HOLDINGS" className="mt-0.5" />
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">
                              {isChinese ? "持仓" : "Holdings"}
                            </span>
                            <span className="text-muted-foreground text-xs">
                              {isChinese ? "仅快照" : "Snapshots only"}
                            </span>
                          </div>
                        </label>
                      </RadioGroup>
                    </div>

                    {setup?.trackingMode === "HOLDINGS" && (
                      <Alert variant="warning">
                        <Icons.AlertTriangle className="h-4 w-4" />
                        <AlertDescription>
                          {isChinese
                            ? "没有交易历史时，绩效指标会受限。"
                            : "Performance metrics will be limited without transaction history."}
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>

        <SheetFooter className="border-t px-6 py-4">
          <Button variant="outline" onClick={handleNotNow} disabled={isSaving}>
            {isChinese ? "暂时不要" : "Not now"}
          </Button>
          <Button onClick={handleSaveAndSync} disabled={isSaving}>
            {isSaving ? (
              <>
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                {isChinese ? "保存中..." : "Saving..."}
              </>
            ) : (
              <>
                <Icons.Check className="mr-2 h-4 w-4" />
                {isChinese ? "保存并同步" : "Save and sync"}
              </>
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
