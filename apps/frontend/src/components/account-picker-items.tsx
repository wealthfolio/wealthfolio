import { AccountTypeIconTile } from "@/components/account-type-icon";
import type { Account } from "@/lib/types";

/**
 * A phone picker screen's account list: each account with its type icon and
 * currency, under its group when the accounts span more than one group.
 */
export function accountPickerItems(accounts: Account[], ungroupedLabel: string) {
  const toItem = (acc: Account) => ({
    value: acc.id,
    label: acc.name,
    icon: <AccountTypeIconTile accountType={acc.accountType} />,
    meta: acc.currency,
  });
  const groups = new Map<string, Account[]>();
  for (const acc of accounts) {
    const key = acc.group?.trim() ?? "";
    groups.set(key, [...(groups.get(key) ?? []), acc]);
  }
  if (groups.size < 2) return accounts.map(toItem);
  return [...groups].map(([group, list]) => ({
    value: group || ungroupedLabel,
    items: list.map(toItem),
  }));
}
