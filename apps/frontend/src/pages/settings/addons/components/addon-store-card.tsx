import { ExternalLink } from "@/components/external-link";
import type { AddonStoreListing } from "@/lib/types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Icons,
  StarRatingDisplay,
} from "@wealthfolio/ui";
import React from "react";
import { useTranslation } from "react-i18next";
import { RatingDialog } from "./rating-dialog";

interface AddonStoreCardProps {
  listing: AddonStoreListing;
  isInstalled?: boolean;
  isInstalling?: boolean;
  onInstall?: (listing: AddonStoreListing) => void;
  onTagClick?: (tag: string) => void;
  onSubmitRating?: (addonId: string, rating: number, review?: string) => Promise<void>;
  isRatingSubmitting?: boolean;
}

export function AddonStoreCard({
  listing,
  isInstalled = false,
  isInstalling = false,
  onInstall,
  onTagClick,
  onSubmitRating: _onSubmitRating,
  isRatingSubmitting: _isRatingSubmitting = false,
}: AddonStoreCardProps) {
  const { t } = useTranslation();
  const [ratingDialogOpen, setRatingDialogOpen] = React.useState(false);
  const addonDetailUrl = `https://wealthfolio.app/addons/${encodeURIComponent(listing.id)}`;

  const formatDownloads = (downloads: number) => {
    if (downloads >= 1000000) {
      return `${(downloads / 1000000).toFixed(1)}M`;
    } else if (downloads >= 1000) {
      return `${(downloads / 1000).toFixed(1)}K`;
    }
    return downloads.toString();
  };

  return (
    <Card className="hover:shadow-primary/10 group relative h-full overflow-hidden transition-all duration-200 hover:shadow-lg">
      <CardHeader className="pb-2 pt-8">
        <CardTitle className="line-clamp-1 text-sm">{listing.name}</CardTitle>
        <CardDescription className="line-clamp-2 text-xs">{listing.description}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Author & Stats */}
        <div className="text-muted-foreground flex items-center justify-between text-sm">
          <div className="flex items-center gap-1">
            <Icons.Users className="h-3 w-3" />
            <span>{t("settings:addon_card_by", { author: listing.author })}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <Icons.Download className="h-3 w-3" />
              <span>{formatDownloads(listing.downloads)}</span>
            </div>
            <span className="text-xs">v{listing.version}</span>
          </div>
        </div>

        {/* Rating Display */}
        {listing.rating > 0 && (
          <StarRatingDisplay
            rating={listing.rating}
            reviewCount={listing.reviewCount}
            size="sm"
            className="mt-1"
          />
        )}

        {/* Mobile Action Buttons - Always visible on mobile, hidden on desktop */}
        <div className="flex gap-2 pt-2 sm:hidden">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="flex-1">
                <Icons.Eye className="mr-2 h-4 w-4" />
                {t("settings:addon_card_details")}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {listing.name}
                  <Badge variant="outline">v{listing.version}</Badge>
                </DialogTitle>
                <DialogDescription className="text-base">{listing.description}</DialogDescription>
              </DialogHeader>

              <div className="space-y-6">
                {/* Screenshots */}
                {listing.images && listing.images.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="font-medium">{t("settings:addon_card_screenshots")}</h4>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {listing.images.map((image, index) => (
                        <div key={index} className="overflow-hidden rounded-lg border">
                          <img
                            src={image}
                            alt={t("settings:addon_card_screenshot_alt", {
                              name: listing.name,
                              index: index + 1,
                            })}
                            className="h-48 w-full object-cover"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Release Notes */}
                <div className="space-y-3">
                  <h4 className="font-medium">{t("settings:addon_card_release_notes")}</h4>
                  <p className="text-muted-foreground text-sm">{listing.releaseNotes}</p>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{t("settings:addon_card_downloads")}</p>
                    <p className="text-primary text-2xl font-bold">
                      {formatDownloads(listing.downloads)}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <p className="text-sm font-medium">{t("settings:addon_card_rating")}</p>
                    <div className="flex flex-col gap-1">
                      <StarRatingDisplay
                        rating={listing.rating || 0}
                        reviewCount={listing.reviewCount || 0}
                        size="sm"
                        showText={true}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{t("settings:addon_card_author")}</p>
                    <p className="text-muted-foreground text-sm">{listing.author}</p>
                  </div>
                </div>

                {/* Rate this addon section */}
                {isInstalled && (
                  <div className="space-y-3">
                    <h4 className="font-medium">{t("settings:addon_card_rate_title")}</h4>
                    <div className="flex items-center gap-3">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRatingDialogOpen(true)}
                        className="flex items-center gap-2"
                      >
                        <Icons.Star className="h-4 w-4" />
                        {t("settings:addon_card_write_review")}
                      </Button>
                      <p className="text-muted-foreground text-sm">
                        {t("settings:addon_card_share_experience")}
                      </p>
                    </div>
                  </div>
                )}

                {/* Tags */}
                {listing.tags && listing.tags.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="font-medium">{t("settings:addon_card_categories")}</h4>
                    <div className="flex flex-wrap gap-2">
                      {listing.tags.map((tag) => (
                        <Badge
                          key={tag}
                          variant="outline"
                          className={`capitalize ${onTagClick ? "hover:bg-primary hover:text-primary-foreground cursor-pointer" : ""}`}
                          onClick={() => onTagClick?.(tag)}
                        >
                          <Icons.Tag className="mr-1 h-3 w-3" />
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-3 pt-4">
                  <Button
                    onClick={() => onInstall?.(listing)}
                    disabled={isInstalled || isInstalling}
                    className="flex-1"
                  >
                    {isInstalling ? (
                      <>
                        <Icons.Loader className="mr-2 h-4 w-4 animate-spin" />
                        {t("settings:addon_card_installing")}
                      </>
                    ) : isInstalled ? (
                      <>
                        <Icons.Check className="mr-2 h-4 w-4" />
                        {t("settings:addon_card_installed")}
                      </>
                    ) : (
                      <>
                        <Icons.Download className="mr-2 h-4 w-4" />
                        {t("settings:addon_card_install")}
                      </>
                    )}
                  </Button>

                  {listing.changelogUrl && (
                    <Button variant="outline" asChild>
                      <ExternalLink href={addonDetailUrl}>
                        <Icons.ExternalLink className="mr-2 h-4 w-4" />
                        {t("settings:addon_card_addon_page")}
                      </ExternalLink>
                    </Button>
                  )}
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {!isInstalled ? (
            <Button
              onClick={() => onInstall?.(listing)}
              disabled={isInstalling || listing.status !== "active"}
              size="sm"
              className="flex-1"
            >
              {isInstalling ? (
                <>
                  <Icons.Loader className="mr-2 h-4 w-4 animate-spin" />
                  {t("settings:addon_card_installing")}
                </>
              ) : listing.status !== "active" ? (
                listing.status === "coming-soon" ? (
                  <>
                    <Icons.Clock className="mr-2 h-4 w-4" />
                    {t("settings:addon_card_coming_soon")}
                  </>
                ) : (
                  <>
                    <Icons.Close className="mr-2 h-4 w-4" />
                    {listing.status === "deprecated"
                      ? t("settings:addon_card_deprecated")
                      : t("settings:addon_card_unavailable")}
                  </>
                )
              ) : (
                <>
                  <Icons.Download className="mr-2 h-4 w-4" />
                  {t("settings:addon_card_install")}
                </>
              )}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => setRatingDialogOpen(true)}
            >
              <Icons.Star className="mr-2 h-4 w-4" />
              {t("settings:addon_card_rate")}
            </Button>
          )}
        </div>
      </CardContent>

      {/* Desktop Overlay Actions - Show on Hover (hidden on mobile) */}
      <div className="absolute inset-0 hidden items-center justify-center gap-2 bg-black/60 opacity-0 transition-opacity duration-200 group-hover:opacity-100 sm:flex">
        {/* View Details Button */}
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="secondary" size="sm" className="bg-white/90 text-black hover:bg-white">
              <Icons.Eye className="mr-2 h-4 w-4" />
              {t("settings:addon_card_details")}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {listing.name}
                <Badge variant="outline">v{listing.version}</Badge>
              </DialogTitle>
              <DialogDescription className="text-base">{listing.description}</DialogDescription>
            </DialogHeader>

            <div className="space-y-6">
              {/* Screenshots */}
              {listing.images && listing.images.length > 0 && (
                <div className="space-y-3">
                  <h4 className="font-medium">{t("settings:addon_card_screenshots")}</h4>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {listing.images.map((image, index) => (
                      <div key={index} className="overflow-hidden rounded-lg border">
                        <img
                          src={image}
                          alt={t("settings:addon_card_screenshot_alt", {
                            name: listing.name,
                            index: index + 1,
                          })}
                          className="h-48 w-full object-cover"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Release Notes */}
              <div className="space-y-3">
                <h4 className="font-medium">{t("settings:addon_card_release_notes")}</h4>
                <p className="text-muted-foreground text-sm">{listing.releaseNotes}</p>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">{t("settings:addon_card_downloads")}</p>
                  <p className="text-primary text-2xl font-bold">
                    {formatDownloads(listing.downloads)}
                  </p>
                </div>

                <div className="space-y-1">
                  <p className="text-sm font-medium">{t("settings:addon_card_rating")}</p>
                  <div className="flex flex-col gap-1">
                    <StarRatingDisplay
                      rating={listing.rating || 0}
                      reviewCount={listing.reviewCount || 0}
                      size="sm"
                      showText={true}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">{t("settings:addon_card_author")}</p>
                  <p className="text-muted-foreground text-sm">{listing.author}</p>
                </div>
              </div>

              {/* Rate this addon section */}
              {isInstalled && (
                <div className="space-y-3">
                  <h4 className="font-medium">{t("settings:addon_card_rate_title")}</h4>
                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setRatingDialogOpen(true)}
                      className="flex items-center gap-2"
                    >
                      <Icons.Star className="h-4 w-4" />
                      {t("settings:addon_card_write_review")}
                    </Button>
                    <p className="text-muted-foreground text-sm">
                      {t("settings:addon_card_share_experience")}
                    </p>
                  </div>
                </div>
              )}

              {/* Tags */}
              {listing.tags && listing.tags.length > 0 && (
                <div className="space-y-3">
                  <h4 className="font-medium">{t("settings:addon_card_categories")}</h4>
                  <div className="flex flex-wrap gap-2">
                    {listing.tags.map((tag) => (
                      <Badge
                        key={tag}
                        variant="outline"
                        className={`capitalize ${onTagClick ? "hover:bg-primary hover:text-primary-foreground cursor-pointer" : ""}`}
                        onClick={() => onTagClick?.(tag)}
                      >
                        <Icons.Tag className="mr-1 h-3 w-3" />
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-3 pt-4">
                <Button
                  onClick={() => onInstall?.(listing)}
                  disabled={isInstalled || isInstalling}
                  className="flex-1"
                >
                  {isInstalling ? (
                    <>
                      <Icons.Loader className="mr-2 h-4 w-4 animate-spin" />
                      {t("settings:addon_card_installing")}
                    </>
                  ) : isInstalled ? (
                    <>
                      <Icons.Check className="mr-2 h-4 w-4" />
                      {t("settings:addon_card_installed")}
                    </>
                  ) : (
                    <>
                      <Icons.Download className="mr-2 h-4 w-4" />
                      {t("settings:addon_card_install")}
                    </>
                  )}
                </Button>

                {listing.changelogUrl && (
                  <Button variant="outline" asChild>
                    <ExternalLink href={addonDetailUrl}>
                      <Icons.ExternalLink className="mr-2 h-4 w-4" />
                      {t("settings:addon_card_addon_page")}
                    </ExternalLink>
                  </Button>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Rate Button - Show only for installed addons */}
        {isInstalled && (
          <Button
            variant="secondary"
            size="sm"
            className="bg-white/90 text-black hover:bg-white"
            onClick={() => setRatingDialogOpen(true)}
          >
            <Icons.Star className="mr-2 h-4 w-4" />
            {t("settings:addon_card_rate")}
          </Button>
        )}

        {/* Install Button */}
        {!isInstalled && (
          <Button
            onClick={() => onInstall?.(listing)}
            disabled={isInstalling || listing.status !== "active"}
            size="sm"
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {isInstalling ? (
              <>
                <Icons.Loader className="mr-2 h-4 w-4 animate-spin" />
                {t("settings:addon_card_installing")}
              </>
            ) : listing.status !== "active" ? (
              listing.status === "coming-soon" ? (
                <>
                  <Icons.Clock className="mr-2 h-4 w-4" />
                  {t("settings:addon_card_coming_soon")}
                </>
              ) : (
                <>
                  <Icons.Close className="mr-2 h-4 w-4" />
                  {listing.status === "deprecated"
                    ? t("settings:addon_card_deprecated")
                    : t("settings:addon_card_unavailable")}
                </>
              )
            ) : (
              <>
                <Icons.Download className="mr-2 h-4 w-4" />
                {t("settings:addon_card_install")}
              </>
            )}
          </Button>
        )}
      </div>

      {/* Status Indicators */}
      <div className="absolute right-2 top-2 flex flex-col gap-1 opacity-90">
        {isInstalled && (
          <Badge
            variant="secondary"
            className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
          >
            <Icons.Check className="mr-1 h-3 w-3" />
            {t("settings:addon_card_installed")}
          </Badge>
        )}
        {listing.status &&
          listing.status !== "active" &&
          (listing.status === "coming-soon" ? (
            <Badge
              variant="default"
              className="bg-primary text-primary-foreground text-xs capitalize"
            >
              <Icons.Clock className="mr-1 h-3 w-3" />
              {t("settings:addon_card_coming_soon")}
            </Badge>
          ) : (
            <Badge
              variant={listing.status === "deprecated" ? "destructive" : "outline"}
              className="text-xs capitalize"
            >
              {listing.status}
            </Badge>
          ))}
      </div>

      {/* Rating Dialog */}
      <RatingDialog
        open={ratingDialogOpen}
        onOpenChange={setRatingDialogOpen}
        addonId={listing.id}
        addonName={listing.name}
        onRatingSubmitted={() => {
          // Could refresh rating data here if needed
        }}
      />
    </Card>
  );
}
