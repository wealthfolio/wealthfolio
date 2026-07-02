import { PermissionDialog } from "@/pages/settings/addons/components/addon-permission-dialog";
import { AddonStoreBrowser } from "@/pages/settings/addons/components/addon-store-browser";
import { AddonUpdateCard } from "@/pages/settings/addons/components/addon-update-card";
import { RatingDialog } from "@/pages/settings/addons/components/rating-dialog";
import {
  Badge,
  Button,
  DeleteConfirm,
  EmptyPlaceholder,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@wealthfolio/ui";
import { useToast } from "@wealthfolio/ui/components/ui/use-toast";
import { useState } from "react";
import { useI18n } from "@/i18n/i18n-provider";
import { SettingsHeader } from "../settings-header";
import { useAddonActions } from "./hooks/use-addon-actions";
import { useAddonUpdates } from "./hooks/use-addon-updates";

export default function AddonSettingsPage() {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const [activeTab, setActiveTab] = useState<"installed" | "store">("installed");
  const [ratingDialog, setRatingDialog] = useState<{
    open: boolean;
    addonId?: string;
    addonName?: string;
  }>({ open: false });

  const {
    installedAddons,
    isLoading,
    isLoadingAddons,
    togglingAddonId,
    permissionDialog,
    viewPermissionDialog,
    loadInstalledAddons,
    handleLoadAddon,
    handleToggleAddon,
    handleUninstallAddon,
    handleViewPermissions,
    setPermissionDialog,
    setViewPermissionDialog,
  } = useAddonActions();

  const {
    isCheckingUpdates,
    checkAllUpdates,
    getUpdateResult,
    hasUpdates,
    getUpdateCount,
    getCriticalUpdateCount,
    clearUpdateResult,
  } = useAddonUpdates({
    installedAddons,
    autoCheck: true,
  });

  const { toast } = useToast();

  const handleCheckUpdates = async () => {
    try {
      await checkAllUpdates();
    } catch (_error) {
      // Error handling is done in the hook
    }
  };

  const handleUpdateComplete = async (addonId: string) => {
    // Refresh addon list and clear update result
    await loadInstalledAddons();
    clearUpdateResult(addonId);
  };

  const handleRateAddon = (addonId: string, addonName: string) => {
    setRatingDialog({
      open: true,
      addonId,
      addonName,
    });
  };

  const handleRatingSubmitted = () => {
    // Could refresh addon data here if needed in the future
    toast({
      title: "Thank you!",
      description: "Your rating has been submitted successfully.",
    });
  };

  const installedAddonIds = installedAddons.map((addon) => addon.metadata.id);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <SettingsHeader
          heading="Addon Manager"
          text="Install and manage add-ons to extend Wealthfolio's functionality."
        />

        <div className="flex items-center gap-3">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon">
                <Icons.Info className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80">
              <div className="space-y-3">
                <div className="space-y-2">
                  <h4 className="font-medium">🔌 Add-ons & Extensions</h4>
                  <p className="text-muted-foreground text-sm">
                    Add-ons let you extend Wealthfolio with new features, custom analytics, and
                    additional functionality to enhance your financial management experience.
                  </p>
                </div>
                <div className="border-t pt-2">
                  <div className="flex items-start gap-2">
                    <Icons.AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    <p className="text-muted-foreground text-xs">
                      <span className="font-medium text-amber-600">Security Notice:</span> Only
                      install add-ons from trusted sources. Add-ons have access to your application
                      data.
                    </p>
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value: string) => setActiveTab(value as "installed" | "store")}
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger
            value="installed"
            className="flex items-center justify-center gap-1.5 sm:gap-2"
          >
            <Icons.Package className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">Installed</span>
            {installedAddons.length > 0 && (
              <Badge variant="secondary" className="ml-0.5 flex-shrink-0 sm:ml-1">
                {installedAddons.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="store" className="flex items-center justify-center gap-1.5 sm:gap-2">
            <Icons.Store className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">Available</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="installed" className="space-y-4">
          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <h3 className="text-base font-medium sm:text-lg">Installed Add-ons</h3>
                <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-sm">
                  <span>
                    {isChinese
                      ? `已安装 ${installedAddons.length} 个插件`
                      : `${installedAddons.length} add-on${
                          installedAddons.length !== 1 ? "s" : ""
                        } installed`}
                  </span>
                  {hasUpdates() && (
                    <Badge
                      variant={getCriticalUpdateCount() > 0 ? "destructive" : "default"}
                      className="text-xs"
                    >
                      {isChinese
                        ? `${getUpdateCount()} 个更新可用${
                            getCriticalUpdateCount() > 0
                              ? `（${getCriticalUpdateCount()} 个关键更新）`
                              : ""
                          }`
                        : `${getUpdateCount()} update${
                            getUpdateCount() !== 1 ? "s" : ""
                          } available${
                            getCriticalUpdateCount() > 0
                              ? ` (${getCriticalUpdateCount()} critical)`
                              : ""
                          }`}
                    </Badge>
                  )}
                </div>
              </div>

              {/* Tab Actions */}
              <div className="flex flex-wrap items-center gap-2">
                {/* Check Updates */}
                <Popover>
                  <PopoverTrigger asChild>
                    <div>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={handleCheckUpdates}
                        disabled={isCheckingUpdates || installedAddons.length === 0}
                        className="hover:bg-muted/50 relative"
                        title="Check for Updates"
                      >
                        {isCheckingUpdates ? (
                          <Icons.Loader className="h-4 w-4 animate-spin" />
                        ) : (
                          <Icons.Refresh className="h-4 w-4" />
                        )}
                        {hasUpdates() && (
                          <div className="bg-destructive absolute -right-1 -top-1 h-2 w-2 rounded-full" />
                        )}
                      </Button>
                    </div>
                  </PopoverTrigger>
                  <PopoverContent className="w-64" side="bottom" align="end">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Icons.Refresh className="h-4 w-4" />
                        <span className="font-medium">Check for Updates</span>
                      </div>
                      <p className="text-muted-foreground text-sm">
                        Check all installed add-ons for available updates from their sources.
                      </p>
                      {hasUpdates() && (
                        <div className="border-t pt-2">
                          <Badge
                            variant={getCriticalUpdateCount() > 0 ? "destructive" : "default"}
                            className="text-xs"
                          >
                            {getUpdateCount()} update{getUpdateCount() !== 1 ? "s" : ""} available
                          </Badge>
                        </div>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Install from File */}
                <Popover>
                  <PopoverTrigger asChild>
                    <div>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={handleLoadAddon}
                        disabled={isLoading}
                        className="hover:bg-muted/50"
                        title="Install from File"
                      >
                        {isLoading ? (
                          <Icons.Loader className="h-4 w-4 animate-spin" />
                        ) : (
                          <Icons.Plus className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </PopoverTrigger>
                  <PopoverContent className="w-64" side="bottom" align="end">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Icons.Plus className="h-4 w-4" />
                        <span className="font-medium">Install from File</span>
                      </div>
                      <p className="text-muted-foreground text-sm">
                        Install an add-on from a local ZIP file. Only install add-ons from trusted
                        sources.
                      </p>
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Browse Addons */}
                <Button
                  variant="outline"
                  onClick={() => setActiveTab("store")}
                  className="flex items-center gap-1.5"
                >
                  <Icons.Store className="h-4 w-4 flex-shrink-0" />
                  <span className="hidden sm:inline">Browse Add-ons</span>
                  <span className="sm:hidden">Browse</span>
                </Button>
              </div>
            </div>

            {isLoadingAddons ? (
              <div className="flex items-center justify-center py-12">
                <Icons.Loader className="text-muted-foreground h-8 w-8 animate-spin" />
                <span className="text-muted-foreground ml-2 text-sm sm:text-base">
                  Loading add-ons...
                </span>
              </div>
            ) : installedAddons.length === 0 ? (
              <EmptyPlaceholder>
                <EmptyPlaceholder.Icon name="Package" />
                <EmptyPlaceholder.Title>No add-ons installed</EmptyPlaceholder.Title>
                <EmptyPlaceholder.Description>
                  Get started by installing your first add-on to extend Wealthfolio&apos;s
                  functionality.
                </EmptyPlaceholder.Description>
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:gap-3">
                  <Button onClick={() => setActiveTab("store")} className="w-full sm:w-auto">
                    <Icons.Store className="mr-2 h-4 w-4" />
                    Browse Add-ons
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleLoadAddon}
                    disabled={isLoading}
                    className="w-full sm:w-auto"
                  >
                    <Icons.Plus className="mr-2 h-4 w-4" />
                    Install from File
                  </Button>
                </div>
              </EmptyPlaceholder>
            ) : (
              <div className="space-y-3">
                {installedAddons.map((addon) => (
                  <div
                    key={addon.metadata.id}
                    className={`group rounded-lg border p-4 transition-all duration-200 sm:p-6 ${
                      addon.metadata.enabled
                        ? "bg-card hover:bg-accent/30 hover:shadow-md"
                        : "bg-muted/30 border-dashed opacity-75 hover:opacity-90"
                    }`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1 space-y-2 sm:space-y-3">
                        {/* Header section with name and version */}
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="flex items-center gap-2">
                            {!addon.metadata.enabled && (
                              <Icons.PauseCircle className="text-muted-foreground/60 h-5 w-5 flex-shrink-0" />
                            )}
                            <h4
                              className={`truncate text-sm font-semibold md:text-lg ${
                                addon.metadata.enabled ? "" : "text-muted-foreground"
                              }`}
                            >
                              {addon.metadata.name}
                            </h4>
                          </div>
                          <Badge
                            variant="outline"
                            className="text-muted-foreground shrink-0 text-xs"
                          >
                            v{addon.metadata.version}
                          </Badge>
                          {!addon.metadata.enabled && (
                            <Badge
                              variant="secondary"
                              className="bg-warning/10 text-warning border-warning/20 shrink-0 text-xs"
                            >
                              <Icons.AlertCircle className="mr-1 h-3 w-3" />
                              Disabled
                            </Badge>
                          )}
                        </div>

                        {/* Description */}
                        {addon.metadata.description && (
                          <p
                            className={`text-xs leading-relaxed sm:text-sm ${
                              addon.metadata.enabled
                                ? "text-muted-foreground"
                                : "text-muted-foreground/70"
                            }`}
                          >
                            {addon.metadata.description}
                          </p>
                        )}

                        {/* Author info */}
                        {addon.metadata.author && (
                          <div
                            className={`flex items-center gap-2 text-xs sm:text-sm ${
                              addon.metadata.enabled
                                ? "text-muted-foreground"
                                : "text-muted-foreground/70"
                            }`}
                          >
                            <Icons.Users className="h-4 w-4 flex-shrink-0" />
                            <span className="truncate">By {addon.metadata.author}</span>
                          </div>
                        )}
                      </div>

                      {/* Controls section */}
                      <div className="flex items-center justify-between gap-2 sm:ml-6 sm:justify-normal">
                        <div className="flex items-center gap-2">
                          {/* Permissions button */}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleViewPermissions(addon)}
                            className="text-muted-foreground hover:bg-accent hover:text-foreground h-9 w-9 p-0 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100"
                          >
                            <Icons.Eye className="h-4 w-4" />
                            <span className="sr-only">View permissions</span>
                          </Button>

                          {/* Rating button */}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRateAddon(addon.metadata.id, addon.metadata.name)}
                            className="text-muted-foreground hover:bg-accent hover:text-foreground h-9 w-9 p-0 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100"
                          >
                            <Icons.Star className="h-4 w-4" />
                            <span className="sr-only">Rate addon</span>
                          </Button>

                          {/* Delete button with confirmation */}
                          <DeleteConfirm
                            deleteConfirmTitle={isChinese ? "移除插件" : "Remove Addon"}
                            deleteConfirmMessage={
                              <div className="space-y-2">
                                <p>
                                  {isChinese ? (
                                    <>
                                      确定要移除 <strong>{addon.metadata.name}</strong> 吗？
                                    </>
                                  ) : (
                                    <>
                                      Are you sure you want to remove{" "}
                                      <strong>{addon.metadata.name}</strong>?
                                    </>
                                  )}
                                </p>
                                <p className="text-muted-foreground text-sm">
                                  {isChinese
                                    ? "此操作无法撤销。该插件会从你的系统中完全移除。"
                                    : "This action cannot be undone. The addon will be completely removed from your system."}
                                </p>
                              </div>
                            }
                            handleDeleteConfirm={() => handleUninstallAddon(addon.metadata.id)}
                            isPending={false}
                            button={
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive h-9 w-9 p-0 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100"
                              >
                                <Icons.Trash className="h-4 w-4" />
                                <span className="sr-only">Remove addon</span>
                              </Button>
                            }
                          />

                          {/* Enable/Disable Switch */}
                          <Switch
                            id={`addon-${addon.metadata.id}`}
                            checked={addon.metadata.enabled}
                            onCheckedChange={(checked) =>
                              handleToggleAddon(addon.metadata.id, !checked)
                            }
                            className="data-[state=checked]:bg-green-600"
                            disabled={togglingAddonId === addon.metadata.id}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Update Card - Show if update is available */}
                    {(() => {
                      const updateResult = getUpdateResult(addon.metadata.id);
                      return updateResult?.updateInfo.updateAvailable ? (
                        <div className="mt-3">
                          <AddonUpdateCard
                            addonId={addon.metadata.id}
                            addonName={addon.metadata.name}
                            updateInfo={updateResult.updateInfo}
                            onUpdateComplete={() => handleUpdateComplete(addon.metadata.id)}
                            disabled={togglingAddonId === addon.metadata.id}
                          />
                        </div>
                      ) : null;
                    })()}
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="store">
          <AddonStoreBrowser
            installedAddonIds={installedAddonIds}
            onInstallSuccess={loadInstalledAddons}
          />
        </TabsContent>
      </Tabs>

      {/* Permission Dialog */}
      <PermissionDialog
        open={permissionDialog.open}
        onOpenChange={(open) => setPermissionDialog({ ...permissionDialog, open })}
        manifest={permissionDialog.manifest}
        declaredPermissions={permissionDialog.permissions || []}
        riskLevel={permissionDialog.riskLevel || "low"}
        onApprove={() => {
          if (permissionDialog.onApprove) {
            permissionDialog.onApprove();
          }
        }}
        onDeny={() => {
          setPermissionDialog({ open: false });
          toast({
            title: "Installation cancelled",
            description: "Addon installation was cancelled by user.",
          });
        }}
      />

      {/* View Permissions Dialog */}
      {viewPermissionDialog.addon && (
        <PermissionDialog
          open={viewPermissionDialog.open}
          onOpenChange={(open) => setViewPermissionDialog({ ...viewPermissionDialog, open })}
          manifest={viewPermissionDialog.addon.metadata}
          declaredPermissions={viewPermissionDialog.permissions || []}
          riskLevel={viewPermissionDialog.riskLevel || "low"}
          onApprove={() => {
            setViewPermissionDialog({ open: false });
          }}
          onDeny={() => {
            setViewPermissionDialog({ open: false });
          }}
          isViewOnly={true}
        />
      )}

      {/* Rating Dialog */}
      <RatingDialog
        open={ratingDialog.open}
        onOpenChange={(open) => setRatingDialog({ ...ratingDialog, open })}
        addonId={ratingDialog.addonId || ""}
        addonName={ratingDialog.addonName || ""}
        onRatingSubmitted={handleRatingSubmitted}
      />
    </div>
  );
}
