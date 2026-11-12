import { invoke } from "#platform";
import type { TaxonomyCategory } from "@/lib/types";
import type { NewBudgetTarget } from "../types/budget";

export type MergeBlockReason =
  | "invalid_destination"
  | "children"
  | "asset_references"
  | "category_rollover"
  | "group_rollover"
  | "exclusions"
  | "budget_destination";

export interface CategoryMergeRequest {
  taxonomyId: string;
  categoryId: string;
  destinationId?: string;
}

export interface CategoryMergeCommit extends CategoryMergeRequest {
  destinationId: string;
  revision: string;
}

export interface CategoryMergeReview {
  source: TaxonomyCategory;
  references: {
    children: number;
    assetAssignments: number;
    spendingAssignments: number;
    splits: number;
    rules: number;
    budgetTargets: number;
    budgetRollovers: number;
    budgetGroupAssignments: number;
    allocationTargets: number;
    automaticBudgetLinks: number;
    mergedCategories: number;
  };
  destinations: { category: TaxonomyCategory; blocked: MergeBlockReason | null }[];
  destinationId: string | null;
  revision: string;
  targets: NewBudgetTarget[];
  budgetChanges: {
    periodKey: string;
    currentAmount: string;
    movedAmount: string;
    newAmount: string;
  }[];
}

export function reviewCategoryMerge(request: CategoryMergeRequest) {
  return invoke<CategoryMergeReview>("review_category_merge", { request });
}

export function mergeCategory(request: CategoryMergeCommit) {
  return invoke<void>("merge_category", { request });
}
