import { Icons, type Icon } from "@wealthfolio/ui/components/ui/icons";

import { AccountType } from "@/lib/constants";

/** The icon for each account type; anything else gets the wallet. */
export const accountTypeIcons: Record<string, Icon> = {
  [AccountType.SECURITIES]: Icons.Briefcase,
  [AccountType.CASH]: Icons.DollarSign,
  [AccountType.CREDIT_CARD]: Icons.CreditCard,
  [AccountType.CRYPTOCURRENCY]: Icons.Bitcoin,
};

export function getAccountTypeIcon(accountType: string | null | undefined): Icon {
  return (accountType && accountTypeIcons[accountType]) || Icons.Wallet;
}
