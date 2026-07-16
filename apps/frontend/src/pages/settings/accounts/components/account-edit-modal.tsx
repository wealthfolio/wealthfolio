import { Dialog, DialogContent } from "@wealthfolio/ui/components/ui/dialog";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { useSettingsContext } from "@/lib/settings-provider";
import type { Account } from "@/lib/types";
import { AccountForm } from "./account-form";

export interface AccountEditModalProps {
  account?: Account;
  open?: boolean;
  onClose?: () => void;
}

export function AccountEditModal({ account, open, onClose }: AccountEditModalProps) {
  const { settings } = useSettingsContext();

  const defaultValues = {
    id: account?.id ?? undefined,
    name: account?.name ?? "",
    balance: account?.balance ?? 0,
    accountType: (account?.accountType ?? "SECURITIES") as
      | "SECURITIES"
      | "CASH"
      | "CREDIT_CARD"
      | "CRYPTOCURRENCY",
    group: account?.group ?? undefined,
    currency: account?.currency ?? settings?.baseCurrency ?? "USD",
    isDefault: account?.isDefault ?? false,
    isActive: account?.id ? account?.isActive : true,
    isArchived: account?.isArchived ?? false,
    trackingMode: account?.trackingMode,
    meta: account?.meta,
  };

  return (
    <Dialog open={open} onOpenChange={onClose} useIsMobile={useIsMobileViewport}>
      <DialogContent
        data-testid="account-modal"
        className="max-h-[90vh] overflow-y-auto p-0 sm:max-w-[920px]"
      >
        <AccountForm defaultValues={defaultValues} onSuccess={onClose} />
      </DialogContent>
    </Dialog>
  );
}
