import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { FacetedFilter } from "@wealthfolio/ui";

import { useTaxonomy } from "@/hooks/use-taxonomies";

import { useEventTypes, useSpendingEvents } from "../hooks/use-spending-events";
import { getEventTypeLabel } from "../lib/labels";
import { PAYEES_TAXONOMY_ID } from "../lib/payee";
import type { ActivityLabel, ActivityLabelFilter } from "../types/insight";

/**
 * What the user picked in the two facets. Each entry is a label key:
 * `payee:<category id>`, `eventType:<event type id>` or `event:<event id>`.
 */
export interface LabelSelection {
  only: Set<string>;
  without: Set<string>;
}

export const EMPTY_LABEL_SELECTION: LabelSelection = { only: new Set(), without: new Set() };

function labelFromKey(key: string): ActivityLabel | null {
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (!id) return null;
  if (kind === "payee") {
    return { kind: "category", taxonomyId: PAYEES_TAXONOMY_ID, categoryId: id };
  }
  if (kind === "eventType") return { kind: "eventType", eventTypeId: id };
  if (kind === "event") return { kind: "event", eventId: id };
  return null;
}

/** The request filter for a selection, or `undefined` when nothing is picked. */
export function toLabelFilter(selection: LabelSelection): ActivityLabelFilter | undefined {
  const labels = (keys: Set<string>) =>
    Array.from(keys)
      .sort()
      .map(labelFromKey)
      .filter((label): label is ActivityLabel => label !== null);
  const include = labels(selection.only);
  const exclude = labels(selection.without);
  if (include.length === 0 && exclude.length === 0) return undefined;
  return { include, exclude };
}

interface SpendingLabelFilterProps {
  value: LabelSelection;
  onChange: (next: LabelSelection) => void;
}

/**
 * Two facets over the same labels: "Only" keeps the spending that carries one
 * of the picked labels, "Without" leaves it out. Payees and event types are
 * listed; single events, which can run to dozens, show up when searched for.
 */
export function SpendingLabelFilter({ value, onChange }: SpendingLabelFilterProps) {
  const { t } = useTranslation();
  const { data: payees } = useTaxonomy(PAYEES_TAXONOMY_ID);
  const { data: eventTypes = [] } = useEventTypes();
  const { data: events = [] } = useSpendingEvents();

  const options = useMemo(
    () => [
      ...(payees?.categories ?? []).map((payee) => ({
        value: `payee:${payee.id}`,
        label: t("spending:insightsPage.labelFilter.payee", { name: payee.name }),
      })),
      ...eventTypes.map((type) => ({
        value: `eventType:${type.id}`,
        label: t("spending:insightsPage.labelFilter.eventType", {
          name: getEventTypeLabel(t, type.id, type.name),
        }),
      })),
      // Newest first, so a search for a place lists the latest trip on top.
      ...[...events]
        .sort((a, b) => b.startDate.localeCompare(a.startDate))
        .map((event) => ({ value: `event:${event.id}`, label: event.name, searchOnly: true })),
    ],
    [payees, eventTypes, events, t],
  );
  const searchPlaceholder = t("spending:insightsPage.labelFilter.search");

  if (options.length === 0) return null;

  return (
    <div className="flex items-center gap-2" data-testid="spending-label-filter">
      <FacetedFilter
        title={t("spending:insightsPage.labelFilter.only")}
        searchPlaceholder={searchPlaceholder}
        contentClassName="w-72"
        options={options}
        selectedValues={value.only}
        onFilterChange={(only) => onChange({ ...value, only })}
      />
      <FacetedFilter
        title={t("spending:insightsPage.labelFilter.without")}
        searchPlaceholder={searchPlaceholder}
        contentClassName="w-72"
        options={options}
        selectedValues={value.without}
        onFilterChange={(without) => onChange({ ...value, without })}
      />
    </div>
  );
}
