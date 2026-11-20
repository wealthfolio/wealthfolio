import { useMemo } from "react";

import { useTaxonomy } from "@/hooks/use-taxonomies";
import type { TaxonomyCategory } from "@/lib/types";

import { PAYEES_TAXONOMY_ID, payeeIdOf } from "../lib/payee";
import { useActivityAssignments } from "./use-cash-activities";

const NO_PAYEES: TaxonomyCategory[] = [];

/** Every payee, and the name of the one `activityId` is filed under ("" when none). */
export function useActivityPayee(activityId: string | null): {
  payees: TaxonomyCategory[];
  payeeName: string;
} {
  const { data: taxonomy } = useTaxonomy(PAYEES_TAXONOMY_ID);
  const { data: assignments } = useActivityAssignments(activityId);
  const payees = taxonomy?.categories ?? NO_PAYEES;
  const payeeName = useMemo(() => {
    const payeeId = payeeIdOf(assignments);
    return payees.find((payee) => payee.id === payeeId)?.name ?? "";
  }, [assignments, payees]);
  return { payees, payeeName };
}
