import type { ActivityDetails } from "@/lib/types";
import type { CashAuditReviewTarget } from "@/pages/account/cash-audit";
import {
  Icons,
  calendarDateFromLocalDate,
  useDateFormatting,
  type FormattingApi,
} from "@wealthfolio/ui";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui/components/ui/sheet";
import { parseISO } from "date-fns";
import { useTranslation } from "react-i18next";
import { ActivityDateList } from "./activity-date-list";

interface ActivityDateSheetProps {
  activities: ActivityDetails[];
  date: string | null;
  isLoading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endingCashBalance?: number;
  cashCurrency?: string;
  cashAuditTarget?: CashAuditReviewTarget;
}

export function ActivityDateSheet({
  activities,
  date,
  isLoading,
  open,
  onOpenChange,
  endingCashBalance,
  cashCurrency,
  cashAuditTarget,
}: ActivityDateSheetProps) {
  const { t } = useTranslation();
  const formatting = useDateFormatting();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex h-full w-full flex-col p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>
            {t("activity:date_sheet.title", {
              date: date ? formatActivityDate(date, formatting) : "",
            })}
          </SheetTitle>
          <SheetDescription>
            {t("activity:date_sheet.count", { count: activities.length })}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-auto px-4 py-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Icons.Spinner className="size-6 animate-spin" />
            </div>
          ) : (
            <ActivityDateList
              activities={activities}
              endingCashBalance={endingCashBalance}
              cashCurrency={cashCurrency}
              cashAuditTarget={cashAuditTarget}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function formatActivityDate(
  date: string,
  formatting: Pick<FormattingApi, "formatCalendarDate">,
): string {
  try {
    return formatting.formatCalendarDate(date, { dateStyle: "long" });
  } catch {
    try {
      return formatting.formatCalendarDate(calendarDateFromLocalDate(parseISO(date)), {
        dateStyle: "long",
      });
    } catch {
      return date;
    }
  }
}
