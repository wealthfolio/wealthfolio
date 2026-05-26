import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { QueryKeys } from "@/lib/query-keys";
import { invalidateSpendingCaches } from "@/features/spending/lib/invalidation";
import {
  getTaxonomies,
  getTaxonomy,
  createTaxonomy,
  updateTaxonomy,
  deleteTaxonomy,
  createCategory,
  updateCategory,
  deleteCategory,
  moveCategory,
  importTaxonomyJson,
  exportTaxonomyJson,
  getAssetTaxonomyAssignments,
  assignAssetToCategory,
  removeAssetTaxonomyAssignment,
  getMigrationStatus,
  migrateLegacyClassifications,
} from "@/adapters";
import type {
  AssetTaxonomyAssignment,
  MigrationResult,
  MigrationStatus,
  NewAssetTaxonomyAssignment,
  NewTaxonomy,
  NewTaxonomyCategory,
  Taxonomy,
  TaxonomyCategory,
  TaxonomyScope,
  TaxonomyWithCategories,
} from "@/lib/types";

const ACTIVITY_TAXONOMY_IDS = new Set(["spending_categories", "income_sources"]);

function invalidateActivityTaxonomyCaches(queryClient: QueryClient, taxonomyId: string) {
  if (ACTIVITY_TAXONOMY_IDS.has(taxonomyId)) {
    invalidateSpendingCaches(queryClient);
  }
}

// ============================================================================
// Taxonomy Queries
// ============================================================================

/**
 * Fetch taxonomies, optionally filtered by scope.
 * - scope="asset" (default for legacy rows): asset classifications shown in Settings → Classifications
 * - scope="activity": spending categories / income sources shown in Spending → Categories
 */
export function useTaxonomies(options?: { scope?: TaxonomyScope }) {
  const query = useQuery<Taxonomy[], Error>({
    queryKey: [QueryKeys.TAXONOMIES],
    queryFn: getTaxonomies,
  });

  if (options?.scope) {
    return {
      ...query,
      data: query.data?.filter((t) => (t.scope ?? "asset") === options.scope),
    };
  }
  return query;
}

export function useTaxonomy(id: string | null) {
  return useQuery<TaxonomyWithCategories | null, Error>({
    queryKey: QueryKeys.taxonomy(id ?? ""),
    queryFn: () => (id ? getTaxonomy(id) : Promise.resolve(null)),
    enabled: !!id,
  });
}

export function useAssetTaxonomyAssignments(assetId: string | null) {
  return useQuery<AssetTaxonomyAssignment[], Error>({
    queryKey: QueryKeys.assetTaxonomyAssignments(assetId ?? ""),
    queryFn: () => (assetId ? getAssetTaxonomyAssignments(assetId) : Promise.resolve([])),
    enabled: !!assetId,
  });
}

// ============================================================================
// Taxonomy Mutations
// ============================================================================

export function useCreateTaxonomy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (taxonomy: NewTaxonomy) => createTaxonomy(taxonomy),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TAXONOMIES] });
    },
  });
}

export function useUpdateTaxonomy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (taxonomy: Taxonomy) => updateTaxonomy(taxonomy),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TAXONOMIES] });
      queryClient.invalidateQueries({ queryKey: QueryKeys.taxonomy(variables.id) });
    },
  });
}

export function useDeleteTaxonomy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteTaxonomy(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TAXONOMIES] });
    },
  });
}

// ============================================================================
// Category Mutations
// ============================================================================

export function useCreateCategory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (category: NewTaxonomyCategory) => createCategory(category),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: QueryKeys.taxonomy(variables.taxonomyId) });
      invalidateActivityTaxonomyCaches(queryClient, variables.taxonomyId);
    },
  });
}

export function useUpdateCategory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (category: TaxonomyCategory) => updateCategory(category),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: QueryKeys.taxonomy(variables.taxonomyId) });
      invalidateActivityTaxonomyCaches(queryClient, variables.taxonomyId);
    },
  });
}

export function useDeleteCategory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taxonomyId, categoryId }: { taxonomyId: string; categoryId: string }) =>
      deleteCategory(taxonomyId, categoryId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: QueryKeys.taxonomy(variables.taxonomyId) });
      invalidateActivityTaxonomyCaches(queryClient, variables.taxonomyId);
    },
  });
}

export function useMoveCategory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      taxonomyId,
      categoryId,
      newParentId,
      position,
    }: {
      taxonomyId: string;
      categoryId: string;
      newParentId: string | null;
      position: number;
    }) => moveCategory(taxonomyId, categoryId, newParentId, position),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: QueryKeys.taxonomy(variables.taxonomyId) });
      invalidateActivityTaxonomyCaches(queryClient, variables.taxonomyId);
    },
  });
}

// ============================================================================
// Import/Export
// ============================================================================

export function useImportTaxonomy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (jsonStr: string) => importTaxonomyJson(jsonStr),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TAXONOMIES] });
    },
  });
}

export function useExportTaxonomy() {
  return useMutation({
    mutationFn: (id: string) => exportTaxonomyJson(id),
  });
}

// ============================================================================
// Assignment Mutations
// ============================================================================

export function useAssignAssetToCategory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (assignment: NewAssetTaxonomyAssignment) => assignAssetToCategory(assignment),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: QueryKeys.assetTaxonomyAssignments(variables.assetId),
      });
      // Invalidate portfolio allocations and holdings to reflect classification changes
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PORTFOLIO_ALLOCATIONS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
    },
  });
}

export function useRemoveAssetTaxonomyAssignment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id }: { id: string; assetId: string }) => removeAssetTaxonomyAssignment(id),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: QueryKeys.assetTaxonomyAssignments(variables.assetId),
      });
      // Invalidate portfolio allocations and holdings to reflect classification changes
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PORTFOLIO_ALLOCATIONS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
    },
  });
}

// ============================================================================
// Classification Queries
// ============================================================================

export function useMigrationStatus() {
  return useQuery<MigrationStatus, Error>({
    queryKey: ["migration-status"],
    queryFn: getMigrationStatus,
  });
}

export function useMigrateLegacyClassifications() {
  const queryClient = useQueryClient();
  return useMutation<MigrationResult, Error>({
    mutationFn: migrateLegacyClassifications,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["migration-status"] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_TAXONOMY_ASSIGNMENTS] });
      // Invalidate portfolio allocations and holdings to reflect classification changes
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PORTFOLIO_ALLOCATIONS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
      // Invalidate health status so health center updates
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HEALTH_STATUS] });
    },
  });
}
