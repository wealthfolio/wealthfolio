import { Dialog, DialogContent } from "@wealthfolio/ui/components/ui/dialog";
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
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[650px]">
        <ContributionLimitForm
          defaultValues={
            limit ?? {
              groupName: "",
              contributionYear: new Date().getFullYear(),
              accountIds: "",
              startDate: new Date(Date.UTC(new Date().getFullYear(), 0, 1, 12, 0, 0)),
              endDate: new Date(Date.UTC(new Date().getFullYear(), 11, 31, 12, 0, 0)),
              isRecurring: false,
            }
          }
          onSuccess={() => {
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
