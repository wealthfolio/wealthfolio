import { getPlatforms } from "@/features/wealthfolio-connect";
import { useAccounts } from "@/hooks/use-accounts";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, Platform } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  EmptyPlaceholder,
  Icons,
  Separator,
  Skeleton,
  ToggleGroup,
  ToggleGroupItem,
} from "@wealthfolio/ui";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { useMemo, useState } from "react";
import { useI18n } from "@/i18n/i18n-provider";
import { SettingsHeader } from "../settings-header";
import { AccountEditModal } from "./components/account-edit-modal";
import { AccountItem } from "./components/account-item";
import { useAccountMutations } from "./components/use-account-mutations";

type FilterType = "all" | "active" | "archived" | "hidden";

const SettingsAccountsPage = () => {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const { accounts, isLoading } = useAccounts({ filterActive: false, includeArchived: true });

  const { data: platforms } = useQuery<Platform[], Error>({
    queryKey: [QueryKeys.PLATFORMS],
    queryFn: getPlatforms,
  });

  // Create a map of platform ID to platform for quick lookup
  const platformMap = useMemo(() => {
    if (!platforms) return new Map<string, Platform>();
    return new Map(platforms.map((p) => [p.id, p]));
  }, [platforms]);

  const [visibleModal, setVisibleModal] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");

  const handleAddAccount = () => {
    setSelectedAccount(null);
    setVisibleModal(true);
  };

  const { deleteAccountMutation, updateAccountMutation } = useAccountMutations({});

  const handleEditAccount = (account: Account) => {
    setSelectedAccount(account);
    setVisibleModal(true);
  };

  const handleDeleteAccount = (account: Account) => {
    deleteAccountMutation.mutate(account.id);
  };

  const handleArchiveAccount = (account: Account, archive: boolean) => {
    updateAccountMutation.mutate({
      ...account,
      isArchived: archive,
    });
  };

  const handleHideAccount = (account: Account, hide: boolean) => {
    updateAccountMutation.mutate({
      ...account,
      isActive: !hide,
    });
  };

  // Filter and search accounts
  const filteredAccounts = useMemo(() => {
    let result = accounts;

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (account) =>
          account.name.toLowerCase().includes(query) ||
          account.group?.toLowerCase().includes(query) ||
          account.currency.toLowerCase().includes(query),
      );
    }

    // Apply status filter
    switch (filter) {
      case "active":
        result = result.filter((a) => a.isActive && !a.isArchived);
        break;
      case "archived":
        result = result.filter((a) => a.isArchived);
        break;
      case "hidden":
        result = result.filter((a) => !a.isActive && !a.isArchived);
        break;
      default:
        break;
    }

    return result;
  }, [accounts, searchQuery, filter]);

  // Split accounts into active and hidden/archived sections
  const { activeAccounts, inactiveAccounts } = useMemo(() => {
    const active = filteredAccounts.filter((a) => a.isActive && !a.isArchived);
    // Sort inactive: hidden first, then archived
    const inactive = filteredAccounts
      .filter((a) => !a.isActive || a.isArchived)
      .sort((a, b) => {
        // Hidden (not archived) comes before archived
        if (a.isArchived && !b.isArchived) return 1;
        if (!a.isArchived && b.isArchived) return -1;
        return 0;
      });
    return { activeAccounts: active, inactiveAccounts: inactive };
  }, [filteredAccounts]);

  // Counts for section headers
  const counts = useMemo(
    () => ({
      active: accounts.filter((a) => a.isActive && !a.isArchived).length,
      hidden: accounts.filter((a) => !a.isActive && !a.isArchived).length,
      archived: accounts.filter((a) => a.isArchived).length,
    }),
    [accounts],
  );

  if (isLoading) {
    return (
      <div>
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  }

  const renderAccountItem = (account: Account) => (
    <AccountItem
      key={account.id}
      account={account}
      platform={account.platformId ? platformMap.get(account.platformId) : undefined}
      onEdit={handleEditAccount}
      onDelete={handleDeleteAccount}
      onArchive={handleArchiveAccount}
      onHide={handleHideAccount}
    />
  );

  const showSections = filter === "all";

  return (
    <>
      <div className="space-y-6">
        <SettingsHeader
          heading="Accounts"
          text=" Manage your investment and saving accounts."
          actionsInline
        >
          {/* Mobile: icon button; Desktop: full button */}
          <>
            <Button
              size="icon"
              className="sm:hidden"
              onClick={() => handleAddAccount()}
              aria-label={isChinese ? "添加账户" : "Add account"}
            >
              <Icons.Plus className="h-4 w-4" />
            </Button>
            <Button size="sm" className="hidden sm:inline-flex" onClick={() => handleAddAccount()}>
              <Icons.Plus className="mr-2 h-4 w-4" />
              {isChinese ? "添加账户" : "Add account"}
            </Button>
          </>
        </SettingsHeader>
        <Separator />

        {/* Search and Filter Bar */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 sm:max-w-sm">
            <Icons.Search className="text-muted-foreground absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
            <Input
              type="text"
              placeholder={isChinese ? "搜索账户..." : "Search accounts..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="!h-9 pl-9 pr-9 text-sm"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="text-muted-foreground hover:text-foreground absolute right-3 top-1/2 -translate-y-1/2"
                aria-label={isChinese ? "清除搜索" : "Clear search"}
              >
                <Icons.Close className="h-4 w-4" />
              </button>
            )}
          </div>

          <ToggleGroup
            type="single"
            value={filter}
            onValueChange={(value) => value && setFilter(value as FilterType)}
            className="bg-muted h-9 rounded-md p-1"
          >
            <ToggleGroupItem
              value="all"
              className="data-[state=on]:bg-background h-7 rounded px-3 text-xs"
            >
              {isChinese ? "全部" : "All"}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="active"
              className="data-[state=on]:bg-background h-7 rounded px-3 text-xs"
            >
              {isChinese ? "活跃" : "Active"}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="hidden"
              className="data-[state=on]:bg-background h-7 rounded px-3 text-xs"
            >
              {isChinese ? "已隐藏" : "Hidden"}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="archived"
              className="data-[state=on]:bg-background h-7 rounded px-3 text-xs"
            >
              {isChinese ? "已归档" : "Archived"}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* Account Lists */}
        <div className="space-y-8">
          {accounts.length === 0 ? (
            <EmptyPlaceholder>
              <EmptyPlaceholder.Icon name="Wallet" />
              <EmptyPlaceholder.Title>
                {isChinese ? "还没有添加账户！" : "No account added!"}
              </EmptyPlaceholder.Title>
              <EmptyPlaceholder.Description>
                {isChinese
                  ? "你还没有任何账户。开始添加你的投资账户。"
                  : "You don't have any account yet. Start adding your investment accounts."}
              </EmptyPlaceholder.Description>
              <Button onClick={() => handleAddAccount()}>
                <Icons.Plus className="mr-2 h-4 w-4" />
                {isChinese ? "添加账户" : "Add an account"}
              </Button>
            </EmptyPlaceholder>
          ) : filteredAccounts.length === 0 ? (
            <div className="text-muted-foreground py-8 text-center">
              {isChinese ? "没有账户匹配你的搜索。" : "No accounts match your search."}
            </div>
          ) : showSections ? (
            <>
              {/* Active Accounts Section */}
              {activeAccounts.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-muted-foreground text-sm font-medium">
                      {isChinese ? "活跃账户" : "Active Accounts"}
                    </h3>
                    <span className="bg-success/20 text-success rounded-full px-2 py-0.5 text-xs font-medium">
                      {counts.active}
                    </span>
                  </div>
                  <div className="divide-border bg-card divide-y rounded-md border">
                    {activeAccounts.map(renderAccountItem)}
                  </div>
                </div>
              )}

              {/* Hidden & Archived Section */}
              {inactiveAccounts.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-muted-foreground text-sm font-medium">
                      {isChinese ? "已隐藏和已归档" : "Hidden & Archived"}
                    </h3>
                    <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium">
                      {counts.hidden + counts.archived}
                    </span>
                  </div>
                  <div className="divide-border bg-card divide-y rounded-md border">
                    {inactiveAccounts.map(renderAccountItem)}
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Flat list when filtered */
            <div className="divide-border bg-card divide-y rounded-md border">
              {filteredAccounts.map(renderAccountItem)}
            </div>
          )}
        </div>
      </div>
      <AccountEditModal
        account={selectedAccount || undefined}
        open={visibleModal}
        onClose={() => setVisibleModal(false)}
      />
    </>
  );
};

export default SettingsAccountsPage;
