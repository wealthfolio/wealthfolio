import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useEventTypes } from "@/features/spending/hooks/use-spending-events";

import { OverviewCard, type OverviewChip } from "./overview-card";

export function EventTypesOverviewCard() {
  const { t } = useTranslation();
  const { data: eventTypes = [], isLoading, isError } = useEventTypes();

  const chips = useMemo<OverviewChip[]>(
    () =>
      eventTypes.map((type) => ({
        id: type.id,
        name: type.name,
        color: type.color ?? null,
      })),
    [eventTypes],
  );

  const total = eventTypes.length;

  return (
    <OverviewCard
      title={t("settings:spending.event_types.title")}
      description={
        total === 0
          ? t("settings:spending.event_types.description_empty")
          : t("settings:spending.event_types.description", { count: total })
      }
      chips={chips}
      manageHref="/settings/spending/events"
      emptyTitle={t("settings:spending.event_types.empty_title")}
      emptyDescription={t("settings:spending.event_types.empty_description")}
      emptyCtaLabel={t("settings:spending.event_types.empty_cta")}
      isLoading={isLoading}
      isError={isError}
      errorTitle={t("settings:spending.event_types.error_title")}
      errorDescription={t("settings:spending.event_types.error_description")}
      chipShape="tag"
      maxVisible={20}
    />
  );
}
