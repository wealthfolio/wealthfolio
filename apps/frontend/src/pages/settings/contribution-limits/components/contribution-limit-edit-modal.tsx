import { Dialog, DialogContent } from "@wealthfolio/ui/components/ui/dialog";
import { useAccounts } from "@/hooks/use-accounts";
import { ContributionLimitForm } from "./contribution-limit-form";
import type { ContributionLimit } from "@/lib/types";

interface ContributionLimitEditModalProps {
  limit: ContributionLimit | null;
  open: boolean;
  onClose: () => void;
}

export function ContributionLimitEditModal({
  limit,
  open,
  onClose,
}: ContributionLimitEditModalProps) {
  const { accounts } = useAccounts({ filterActive: false });
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="overflow-y-auto [--overlay-max-height:90vh] sm:max-w-162.5">
        <ContributionLimitForm
          defaultValues={
            limit ?? {
              groupName: "",
              contributionYear: new Date().getFullYear(),
              accountIds: "",
              startDate: new Date(new Date().getFullYear(), 0, 1),
              endDate: new Date(new Date().getFullYear(), 11, 31),
              isRecurring: false,
            }
          }
          accounts={accounts}
          onSuccess={() => {
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
