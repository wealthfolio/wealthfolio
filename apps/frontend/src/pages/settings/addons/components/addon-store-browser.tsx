import type { AddonStoreListing } from "@/lib/types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyPlaceholder,
  Icons,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
} from "@wealthfolio/ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAddonActions } from "../hooks/use-addon-actions";
import { useAddonStore } from "../hooks/use-addon-store";
import { PermissionDialog } from "./addon-permission-dialog";
import { AddonStoreCard } from "./addon-store-card";

interface AddonStoreBrowserProps {
  installedAddonIds: string[];
  onInstallSuccess?: () => void;
}

// Helper function to check if an addon should be displayed
const isAddonDisplayable = (listing: AddonStoreListing) => {
  const allowedStatuses = ["active", "deprecated", "coming-soon"];
  return !listing.status || allowedStatuses.includes(listing.status);
};

export function AddonStoreBrowser({ installedAddonIds, onInstallSuccess }: AddonStoreBrowserProps) {
  const { t } = useTranslation();
  const {
    storeListings,
    isLoadingStore,
    fetchStoreListings,
    installFromStore,
    isAddonInstalling,
    submitRating,
    isRatingSubmitting,
  } = useAddonStore();

  const addonActions = useAddonActions();
  const { permissionDialog, setPermissionDialog } = addonActions;

  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"popular" | "rating" | "recent" | "name">("popular");
  const [filterBy, setFilterBy] = useState<"all" | "uninstalled">("all");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  // TanStack Query automatically fetches store listings on component mount

  const filteredAndSortedListings = useMemo(() => {
    const filtered = storeListings.filter((listing) => {
      // Only show active, deprecated, and coming-soon addons (exclude inactive)
      if (!isAddonDisplayable(listing)) return false;

      // Search filter
      const matchesSearch =
        searchQuery === "" ||
        listing.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        listing.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        listing.author.toLowerCase().includes(searchQuery.toLowerCase()) ||
        listing.tags?.some((tag: string) => tag.toLowerCase().includes(searchQuery.toLowerCase()));

      if (!matchesSearch) return false;

      // Tag filter
      if (selectedTag && !listing.tags?.includes(selectedTag)) {
        return false;
      }

      // Category filter
      switch (filterBy) {
        case "uninstalled":
          return !installedAddonIds.includes(listing.id);
        default:
          return true;
      }
    });

    // Sort
    filtered.sort((a, b) => {
      // Always prioritize coming-soon addons first
      if (a.status === "coming-soon" && b.status !== "coming-soon") {
        return -1;
      }
      if (b.status === "coming-soon" && a.status !== "coming-soon") {
        return 1;
      }

      // If both or neither are coming-soon, apply regular sorting
      switch (sortBy) {
        case "popular":
          return b.downloads - a.downloads;
        case "rating":
          return b.rating - a.rating;
        case "recent":
          return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
        case "name":
          return a.name.localeCompare(b.name);
        default:
          return 0;
      }
    });

    return filtered;
  }, [storeListings, searchQuery, sortBy, filterBy, selectedTag, installedAddonIds]);

  const handleInstall = async (listing: AddonStoreListing) => {
    try {
      await installFromStore(listing, true, addonActions.handleShowPermissionDialog);
      onInstallSuccess?.();
    } catch (_error) {
      // Error handling is done in the hook
    }
  };

  const getFilterCounts = () => {
    // Only count addons that would be displayed (exclude inactive)
    const displayableAddons = storeListings.filter(isAddonDisplayable);

    const total = displayableAddons.length;
    const uninstalled = displayableAddons.filter((l) => !installedAddonIds.includes(l.id)).length;
    return { total, uninstalled };
  };

  const counts = getFilterCounts();

  // Get popular tags from all displayable addons
  const getPopularTags = () => {
    const tagCounts = new Map<string, number>();

    storeListings.filter(isAddonDisplayable).forEach((listing) => {
      if (listing.tags) {
        listing.tags.forEach((tag: string) => {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        });
      }
    });

    // Sort by count and return top 8 tags
    return Array.from(tagCounts.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([tag]) => tag);
  };

  const popularTags = getPopularTags();

  const AddonStoreSkeleton = () => (
    <div className="space-y-6">
      {/* Filters and Search Skeleton */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Skeleton className="h-10 w-full" />
        </div>
        <Skeleton className="h-10 w-full sm:w-[180px]" />
        <Skeleton className="h-10 w-full sm:w-[180px]" />
        <Skeleton className="h-10 w-10" />
      </div>

      {/* Results summary skeleton */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-48" />
      </div>

      {/* Addon Grid Skeleton */}
      <div className="grid gap-6 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="h-full">
            <CardHeader className="pb-2">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <Skeleton className="h-3 w-3 rounded-full" />
                  <Skeleton className="h-4 w-16" />
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1">
                    <Skeleton className="h-3 w-3 rounded-full" />
                    <Skeleton className="h-4 w-8" />
                  </div>
                  <Skeleton className="h-3 w-8" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );

  if (isLoadingStore) {
    return <AddonStoreSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Filters and Search */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        {/* Search */}
        <div className="relative flex-1">
          <Icons.Search className="text-muted-foreground absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
          <Input
            placeholder={t("settings:addon_store_search")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Sort */}
        <Select
          value={sortBy}
          onValueChange={(value: string) =>
            setSortBy(value as "popular" | "rating" | "recent" | "name")
          }
        >
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder={t("settings:addon_store_sort_placeholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="popular">{t("settings:addon_store_sort_popular")}</SelectItem>
            <SelectItem value="rating">{t("settings:addon_store_sort_rating")}</SelectItem>
            <SelectItem value="recent">{t("settings:addon_store_sort_recent")}</SelectItem>
            <SelectItem value="name">{t("settings:addon_store_sort_name")}</SelectItem>
          </SelectContent>
        </Select>

        {/* Filter */}
        <Select
          value={filterBy}
          onValueChange={(value: string) => setFilterBy(value as "all" | "uninstalled")}
        >
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder={t("settings:addon_store_filter_placeholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {t("settings:addon_store_filter_all", { count: counts.total })}
            </SelectItem>
            <SelectItem value="uninstalled">
              {t("settings:addon_store_filter_uninstalled", { count: counts.uninstalled })}
            </SelectItem>
          </SelectContent>
        </Select>

        {/* Refresh Button */}
        <Button
          variant="outline"
          size="icon"
          onClick={() => fetchStoreListings()}
          disabled={isLoadingStore}
          title={t("settings:addon_store_refresh")}
        >
          <Icons.Refresh className="h-4 w-4" />
        </Button>
      </div>

      {/* Results */}
      <div className="space-y-4">
        {/* Results summary */}
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-sm">
            {t("settings:addon_store_showing", {
              count: filteredAndSortedListings.length,
              total: storeListings.length,
            })}
            {searchQuery && <> {t("settings:addon_store_search_for", { query: searchQuery })}</>}
          </p>

          {searchQuery && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSearchQuery("")}
              className="h-auto p-1 text-xs"
            >
              <Icons.Close className="mr-1 h-3 w-3" />
              {t("settings:addon_store_clear_search")}
            </Button>
          )}
        </div>

        {/* Addon Grid */}
        {filteredAndSortedListings.length === 0 ? (
          <EmptyPlaceholder>
            <EmptyPlaceholder.Icon name="Search" />
            <EmptyPlaceholder.Title>{t("settings:addon_store_no_addons")}</EmptyPlaceholder.Title>
            <EmptyPlaceholder.Description>
              {searchQuery
                ? t("settings:addon_store_no_match", { query: searchQuery })
                : t("settings:addon_store_no_filters")}
            </EmptyPlaceholder.Description>
            <div className="flex gap-2">
              {searchQuery && (
                <Button variant="outline" onClick={() => setSearchQuery("")}>
                  {t("settings:addon_store_clear_search_button")}
                </Button>
              )}
              <Button variant="outline" onClick={() => setFilterBy("all")}>
                {t("settings:addon_store_show_all")}
              </Button>
            </div>
          </EmptyPlaceholder>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            {filteredAndSortedListings.map((listing) => (
              <AddonStoreCard
                key={listing.id}
                listing={listing}
                isInstalled={installedAddonIds.includes(listing.id)}
                isInstalling={isAddonInstalling(listing.id)}
                onInstall={handleInstall}
                onTagClick={setSelectedTag}
                onSubmitRating={submitRating}
                isRatingSubmitting={isRatingSubmitting(listing.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Popular Categories */}
      {searchQuery === "" && filterBy === "all" && !selectedTag && popularTags.length > 0 && (
        <div className="space-y-4">
          <Separator />
          <div>
            <h3 className="mb-3 text-lg font-semibold">{t("settings:addon_store_categories")}</h3>
            <div className="flex flex-wrap gap-2">
              {popularTags.map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="hover:bg-primary hover:text-primary-foreground cursor-pointer capitalize"
                  onClick={() => setSelectedTag(tag)}
                >
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Active Tag Filter */}
      {selectedTag && (
        <div className="flex items-center gap-2">
          <Badge variant="default" className="capitalize">
            {selectedTag}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedTag(null)}
            className="h-6 px-2 text-xs"
          >
            {t("settings:addon_store_clear_filter")}
          </Button>
        </div>
      )}

      {/* Permission Dialog */}
      <PermissionDialog
        open={permissionDialog.open}
        onOpenChange={(open) => {
          if (!open && permissionDialog.open) {
            void permissionDialog.onCancel?.();
          }
          setPermissionDialog({ ...permissionDialog, open });
        }}
        manifest={permissionDialog.manifest}
        declaredPermissions={permissionDialog.permissions || []}
        riskLevel={permissionDialog.riskLevel || "low"}
        onApprove={permissionDialog.onApprove || (() => undefined)}
        onDeny={() => {
          void permissionDialog.onCancel?.();
          setPermissionDialog({ open: false });
        }}
      />
    </div>
  );
}
