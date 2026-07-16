import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { isDesktop, openUrlInBrowser } from "@/adapters";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@wealthfolio/ui/components/ui/carousel";
import { Progress } from "@wealthfolio/ui/components/ui/progress";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import {
  useCheckUpdateOnStartup,
  useClearUpdate,
  useInstallUpdate,
  UPDATE_DISMISSED_KEY,
} from "@/hooks/use-updater";
import { Icons } from "@wealthfolio/ui";
import { usePersistentState } from "@wealthfolio/ui/hooks/use-persistent-state";

interface DismissedUpdate {
  version: string;
  dismissedAt: number;
}

const SNOOZE_DURATION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isDismissed(dismissed: DismissedUpdate | null, version: string): boolean {
  if (dismissed?.version !== version) return false;
  return Date.now() - dismissed.dismissedAt < SNOOZE_DURATION_MS;
}

function formatReleaseDate(pubDate?: string) {
  if (!pubDate) {
    return null;
  }

  const parsed = new Date(pubDate);
  if (Number.isNaN(parsed.getTime())) {
    return pubDate;
  }

  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function UpdateDialog() {
  const { t } = useTranslation();
  const { data: updateInfo } = useCheckUpdateOnStartup();
  const clearUpdate = useClearUpdate();
  const [isOpen, setIsOpen] = useState(false);
  const { install, phase, progress, error, isPending, reset } = useInstallUpdate();
  const isDesktopEnv = isDesktop;
  const [dismissedUpdate, setDismissedUpdate] = usePersistentState<DismissedUpdate | null>(
    UPDATE_DISMISSED_KEY,
    null,
  );

  const screenshots = updateInfo?.screenshots ?? [];

  useEffect(() => {
    if (updateInfo && !isDismissed(dismissedUpdate, updateInfo.latestVersion)) {
      setIsOpen(true);
    }
  }, [updateInfo, dismissedUpdate]);

  // X button, Escape, backdrop — dismiss for current session only
  const handleDismiss = useCallback(() => {
    if (isPending) return;
    setIsOpen(false);
    clearUpdate();
    reset();
  }, [isPending, clearUpdate, reset]);

  // "Remind me later" — snooze for 3 days
  const handleSnooze = useCallback(() => {
    if (isPending) return;
    if (updateInfo?.latestVersion) {
      setDismissedUpdate({ version: updateInfo.latestVersion, dismissedAt: Date.now() });
    }
    setIsOpen(false);
    clearUpdate();
    reset();
  }, [isPending, updateInfo?.latestVersion, setDismissedUpdate, clearUpdate, reset]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen || isPending) return;
      if (e.key === "Escape") {
        handleDismiss();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isPending, handleDismiss]);

  const handleInstall = () => {
    install();
  };

  const handleOpenStore = async () => {
    if (!updateInfo?.storeUrl) return;

    try {
      await openUrlInBrowser(updateInfo.storeUrl);
    } catch (error) {
      toast({
        title: t("common:component.unable_to_open_link"),
        description: t("common:component.try_open_link_manually"),
        variant: "destructive",
      });
      console.error("Failed to open store for update", error);
    }
  };

  const handleOpenChangelog = async () => {
    if (!updateInfo?.changelogUrl) return;

    try {
      await openUrlInBrowser(updateInfo.changelogUrl);
    } catch (error) {
      toast({
        title: t("common:component.unable_to_open_changelog"),
        description: t("common:component.try_open_changelog_manually"),
        variant: "destructive",
      });
      console.error("Failed to open changelog", error);
    }
  };

  const releaseDate = formatReleaseDate(updateInfo?.pubDate);

  if (!isOpen || !updateInfo) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="bg-background/80 animate-in fade-in absolute inset-0 backdrop-blur-sm duration-300"
        onClick={handleDismiss}
      />

      {/* Dialog */}
      <div className="border-border bg-card animate-in zoom-in-95 fade-in relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border shadow-2xl duration-300">
        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto">
          {/* Header */}
          <div className="relative px-6 pb-4 pt-6">
            <button
              onClick={handleDismiss}
              className="bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground absolute right-4 top-4 rounded-full p-2 transition-all duration-200 hover:scale-105"
              aria-label={t("common:component.close_dialog")}
            >
              <Icons.Close className="h-4 w-4" />
            </button>

            {/* Version badge */}
            <div className="mb-4 flex items-center gap-3">
              <span className="bg-primary/10 text-primary inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-sm font-medium">
                <Icons.Sparkles className="h-3.5 w-3.5" />v{updateInfo.latestVersion}
              </span>
              {releaseDate && <span className="text-muted-foreground text-sm">{releaseDate}</span>}
            </div>

            {/* Title */}
            <div className="mb-3 space-y-3">
              <h2 className="text-foreground text-balance text-2xl font-bold">
                {t("common:component.new_update_available")}
              </h2>
            </div>

            {/* Description */}
            {updateInfo.notes && (
              <p className="text-muted-foreground text-pretty text-sm leading-relaxed">
                {updateInfo.notes}
              </p>
            )}
          </div>

          {/* Screenshot Carousel */}
          {screenshots.length > 0 && (
            <div className="px-6 pb-4">
              <Carousel className="w-full">
                <CarouselContent>
                  {screenshots.map((screenshotUrl, index) => (
                    <CarouselItem key={index}>
                      <div className="border-border bg-secondary/30 relative aspect-video overflow-hidden rounded-xl border">
                        <img
                          src={screenshotUrl}
                          alt={t("common:component.screenshot_alt", { number: index + 1 })}
                          className="object-cover"
                        />
                      </div>
                    </CarouselItem>
                  ))}
                </CarouselContent>
                {screenshots.length > 1 && (
                  <>
                    <CarouselPrevious className="left-3" />
                    <CarouselNext className="right-3" />
                  </>
                )}
              </Carousel>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="border-border bg-secondary/30 flex shrink-0 flex-col gap-3 border-t px-6 py-4">
          {isPending ? (
            // Download / install progress
            <div className="flex flex-col gap-2">
              {phase === "downloading" ? (
                <>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {t("common:component.downloading_update")}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {progress.total
                        ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
                        : formatBytes(progress.downloaded)}
                    </span>
                  </div>
                  <Progress
                    value={
                      progress.total ? (progress.downloaded / progress.total) * 100 : undefined
                    }
                    className="h-2"
                  />
                </>
              ) : (
                <div className="flex items-center gap-2 text-sm">
                  <Icons.Spinner className="h-4 w-4 animate-spin" />
                  <span className="text-muted-foreground">
                    {t("common:component.installing_update")}
                  </span>
                </div>
              )}
            </div>
          ) : phase === "error" ? (
            // Error state with retry
            <div className="flex items-center justify-between gap-4">
              <p className="text-destructive text-sm">
                {error || t("common:component.update_failed")}
              </p>
              <div className="flex items-center gap-3">
                <Button variant="ghost" onClick={handleDismiss}>
                  {t("common:close")}
                </Button>
                <Button onClick={handleInstall}>{t("common:retry")}</Button>
              </div>
            </div>
          ) : (
            // Default actions
            <div className="flex items-center justify-between gap-4">
              <Button variant="ghost" onClick={handleSnooze}>
                {t("common:component.remind_me_later")}
              </Button>
              <div className="flex items-center gap-3">
                {updateInfo.changelogUrl && (
                  <Button variant="outline" onClick={handleOpenChangelog}>
                    {t("common:component.view_changelog")}
                  </Button>
                )}
                {isDesktopEnv ? (
                  updateInfo.isAppStoreBuild ? (
                    <Button onClick={handleOpenStore} disabled={!updateInfo.storeUrl}>
                      {t("common:component.open_app_store")}
                    </Button>
                  ) : (
                    <Button onClick={handleInstall}>
                      <Icons.Download className="mr-2 h-4 w-4" />
                      {t("common:component.update_now")}
                    </Button>
                  )
                ) : (
                  <Button onClick={handleOpenStore} disabled={!updateInfo.storeUrl}>
                    <Icons.ExternalLink className="mr-2 h-4 w-4" />
                    {t("common:component.view_release")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
