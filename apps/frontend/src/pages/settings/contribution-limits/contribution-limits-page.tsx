import { getContributionLimit } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { QueryKeys } from "@/lib/query-keys";
import type { ContributionLimit } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { Button, EmptyPlaceholder, Icons, Separator, Skeleton } from "@wealthfolio/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsHeader } from "../settings-header";
import { ContributionLimitEditModal } from "./components/contribution-limit-edit-modal";
import { ContributionLimitItem } from "./components/contribution-limit-item";
import { useContributionLimitMutations } from "./use-contribution-limit-mutations";

const SettingsContributionLimitPage = () => {
  const { t } = useTranslation();
  const [visibleModal, setVisibleModal] = useState(false);
  const [selectedLimit, setSelectedLimit] = useState<ContributionLimit | null>(null);
  const [showPreviousYears, setShowPreviousYears] = useState(false);

  const { accounts } = useAccounts();

  const { data: limits, isLoading } = useQuery<ContributionLimit[], Error>({
    queryKey: [QueryKeys.CONTRIBUTION_LIMITS],
    queryFn: getContributionLimit,
  });

  const { deleteContributionLimitMutation } = useContributionLimitMutations();

  const handleAddLimit = () => {
    setSelectedLimit(null);
    setVisibleModal(true);
  };

  const handleEditLimit = (limit: ContributionLimit) => {
    setSelectedLimit(limit);
    setVisibleModal(true);
  };

  const handleDeleteLimit = (limit: ContributionLimit) => {
    deleteContributionLimitMutation.mutate(limit.id);
  };

  if (isLoading) {
    return (
      <div>
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  }

  const currentYear = new Date().getFullYear();
  const currentYearLimits = limits?.filter((limit) => limit.contributionYear === currentYear) || [];
  const previousYearsLimits = limits?.filter((limit) => limit.contributionYear < currentYear) || [];

  return (
    <>
      <div className="space-y-6">
        <SettingsHeader
          heading={t("settings:limits_full_title")}
          text={t("settings:limits_description")}
          actionsInline
        >
          <>
            <Button
              size="icon"
              className="sm:hidden"
              onClick={() => handleAddLimit()}
              aria-label={t("settings:limits_add_aria")}
            >
              <Icons.Plus className="size-4" />
            </Button>
            <Button size="sm" className="hidden sm:inline-flex" onClick={() => handleAddLimit()}>
              <Icons.Plus className="mr-2 size-4" />
              {t("settings:limits_add_button")}
            </Button>
          </>
        </SettingsHeader>
        <Separator />
        <div className="w-full pt-8">
          <h2 className="text-md text-muted-foreground mb-3 font-semibold">
            {t("settings:limits_current_year", { year: currentYear })}
          </h2>
          {currentYearLimits.length ? (
            <div className="w-full space-y-4">
              {currentYearLimits.map((limit: ContributionLimit) => (
                <ContributionLimitItem
                  key={limit.id}
                  limit={limit}
                  accounts={accounts || []}
                  onEdit={handleEditLimit}
                  onDelete={handleDeleteLimit}
                />
              ))}
            </div>
          ) : (
            <EmptyPlaceholder>
              <EmptyPlaceholder.Icon name="CircleGauge" />
              <EmptyPlaceholder.Title>
                {t("settings:limits_empty_title", { year: currentYear })}
              </EmptyPlaceholder.Title>
              <EmptyPlaceholder.Description>
                {t("settings:limits_empty_description")}
              </EmptyPlaceholder.Description>
              <Button onClick={() => handleAddLimit()}>
                <Icons.Plus className="mr-2 h-4 w-4" />
                {t("settings:limits_add_first")}
              </Button>
            </EmptyPlaceholder>
          )}

          {previousYearsLimits.length > 0 && (
            <div className="mt-8">
              <div className="flex items-center justify-center">
                <Separator className="flex-1" />
                <Button
                  variant="outline"
                  className="mx-4 shrink-0 rounded-full"
                  onClick={() => setShowPreviousYears(!showPreviousYears)}
                >
                  {showPreviousYears
                    ? t("settings:limits_hide_previous")
                    : t("settings:limits_show_previous")}{" "}
                  {t("settings:limits_previous_years")}
                </Button>
                <Separator className="flex-1" />
              </div>

              {showPreviousYears && (
                <div className="mt-8">
                  <h2 className="text-md text-muted-foreground mb-3">
                    {t("settings:limits_previous_years")}
                  </h2>
                  <div className="w-full space-y-4">
                    {previousYearsLimits.map((limit: ContributionLimit) => (
                      <ContributionLimitItem
                        key={limit.id}
                        limit={limit}
                        accounts={accounts || []}
                        onEdit={handleEditLimit}
                        onDelete={handleDeleteLimit}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <ContributionLimitEditModal
        limit={selectedLimit}
        open={visibleModal}
        onClose={() => setVisibleModal(false)}
      />
    </>
  );
};

export default SettingsContributionLimitPage;
