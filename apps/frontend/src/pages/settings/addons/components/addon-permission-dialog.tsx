import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import type {
  AddonManifest,
  Permission,
  PermissionCategory,
  RiskLevel,
} from "@wealthfolio/addon-sdk";
import { isBaselineCategory } from "@wealthfolio/addon-sdk";
import { AlertFeedback } from "@wealthfolio/ui";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PermissionCategoriesDisplay } from "./permission-categories-display";

interface PermissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  manifest?: AddonManifest;
  detectedCategories?: PermissionCategory[];
  declaredPermissions?: Permission[];
  riskLevel: RiskLevel;
  onApprove: (approvedNetworkHosts: string[]) => void;
  onDeny: () => void;
  isViewOnly?: boolean;
  canEditNetworkHosts?: boolean;
}

const getWarningVariantByFunctionCount = (
  functionCount: number,
): "success" | "warning" | "error" => {
  if (functionCount <= 3) {
    return "success";
  } else if (functionCount <= 8) {
    return "warning";
  } else {
    return "error";
  }
};

export function PermissionDialog({
  open,
  onOpenChange,
  manifest,
  declaredPermissions = [],
  riskLevel: _riskLevel, // Keep in interface but not used in implementation
  onApprove,
  onDeny,
  isViewOnly = false,
  canEditNetworkHosts = false,
}: PermissionDialogProps) {
  const { t } = useTranslation();
  const networkHosts = useMemo(() => {
    const hosts = manifest?.network?.allowedHosts ?? [];
    return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean))).sort();
  }, [manifest]);
  const defaultApprovedNetworkHosts = useMemo(() => {
    const approvedHosts = manifest?.network?.approvedHosts ?? [];
    return approvedHosts.filter((host) => networkHosts.includes(host));
  }, [manifest, networkHosts]);
  const [approvedNetworkHosts, setApprovedNetworkHosts] = useState<string[]>(
    defaultApprovedNetworkHosts,
  );
  const canManageNetworkHosts = isViewOnly && canEditNetworkHosts && networkHosts.length > 0;

  useEffect(() => {
    if (open) {
      setApprovedNetworkHosts(defaultApprovedNetworkHosts);
    }
  }, [defaultApprovedNetworkHosts, open]);

  const toggleNetworkHost = (host: string, checked: boolean | "indeterminate") => {
    setApprovedNetworkHosts((current) => {
      if (checked === true) {
        return Array.from(new Set([...current, host])).sort();
      }
      return current.filter((currentHost) => currentHost !== host);
    });
  };

  // Safety check - don't render if manifest is missing
  if (!manifest) {
    return null;
  }

  // For installation (not view-only), use manifest permissions
  // For view-only, use declared permissions passed in.
  // Baseline capabilities (ui/query/toast/logger/storage) are implicit and never
  // consent-surfaced, so they are filtered out here — this also hides legacy
  // manifests that still declare them.
  const permissionsToDisplay = (
    isViewOnly ? declaredPermissions : manifest.permissions || []
  ).filter((permission) => !isBaselineCategory(permission.category));

  // Calculate total function count from all permissions
  const totalFunctionCount = permissionsToDisplay.reduce(
    (total, permission) => total + permission.functions.length,
    0,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex flex-col gap-3 md:flex-row md:items-center">
            <Icons.Settings className="hidden h-5 w-5 md:block" />
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
              <span className="text-base md:text-lg">{manifest.name}</span>
              <div className="flex items-center gap-2">
                <Badge variant="outline">v{manifest.version}</Badge>
                {manifest.author && (
                  <Badge variant="outline" className="flex items-center gap-1">
                    <Icons.Users className="h-3 w-3" />
                    <span>{t("settings:addon_card_by", { author: manifest.author })}</span>
                  </Badge>
                )}
              </div>
            </div>
          </DialogTitle>
          <DialogDescription>{manifest.description}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-6 overflow-hidden">
          {/* Function Count Warning */}
          <div className="pt-8">
            <AlertFeedback variant={getWarningVariantByFunctionCount(totalFunctionCount)}>
              {totalFunctionCount <= 3 && t("settings:addon_permission_minimal")}
              {totalFunctionCount > 3 &&
                totalFunctionCount <= 8 &&
                t("settings:addon_permission_moderate")}
              {totalFunctionCount > 8 && t("settings:addon_permission_extensive")}
            </AlertFeedback>
          </div>

          {/* Data Access Permissions using shared component - Make scrollable */}
          <div className="flex-1 overflow-auto">
            <PermissionCategoriesDisplay permissions={permissionsToDisplay} />
          </div>

          {networkHosts.length > 0 && (
            <div className="space-y-3 rounded-md border p-4">
              <div className="flex items-center gap-2">
                <Icons.Globe className="text-muted-foreground h-4 w-4" />
                <h3 className="text-sm font-medium">
                  {t("settings:addon_permission_network_hosts")}
                </h3>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {networkHosts.map((host) => {
                  const checked = approvedNetworkHosts.includes(host);
                  return (
                    <label
                      key={host}
                      className="flex min-w-0 items-center gap-3 rounded-md border px-3 py-2 text-sm"
                    >
                      <Checkbox
                        checked={checked}
                        disabled={isViewOnly && !canManageNetworkHosts}
                        onCheckedChange={(value) => toggleNetworkHost(host, value)}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{host}</span>
                      {isViewOnly && (
                        <Badge variant={checked ? "default" : "outline"} className="shrink-0">
                          {checked
                            ? t("settings:addon_permission_approved")
                            : t("settings:addon_permission_denied")}
                        </Badge>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-3">
          {isViewOnly ? (
            canManageNetworkHosts ? (
              <>
                <Button variant="outline" onClick={onDeny}>
                  <Icons.Close className="mr-2 h-4 w-4" />
                  {t("settings:common_close")}
                </Button>
                <Button onClick={() => onApprove(approvedNetworkHosts)}>
                  <Icons.Check className="mr-2 h-4 w-4" />
                  {t("settings:common_save")}
                </Button>
              </>
            ) : (
              <Button onClick={() => onApprove(approvedNetworkHosts)}>
                <Icons.Check className="mr-2 h-4 w-4" />
                {t("settings:addon_permission_close")}
              </Button>
            )
          ) : (
            <>
              <Button variant="outline" onClick={onDeny}>
                <Icons.Close className="mr-2 h-4 w-4" />
                {t("settings:addon_permission_deny")}
              </Button>
              <Button onClick={() => onApprove(approvedNetworkHosts)}>
                <Icons.Check className="mr-2 h-4 w-4" />
                {t("settings:addon_permission_approve")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
