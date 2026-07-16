import type { FunctionPermission, Permission } from "@/adapters";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { useTranslation } from "react-i18next";
import { getFunctionDisplayName } from "@/pages/settings/addons/components/addon-function-names";
import { getPermissionCategory, isBaselineCategory } from "@wealthfolio/addon-sdk";

interface PermissionForDisplay {
  category: string;
  name: string;
  description: string;
  riskLevel: string;
  functions: FunctionPermission[];
  purpose: string;
}

interface PermissionCategoriesDisplayProps {
  permissions: Permission[];
}

// Helper to convert SDK Permission to display format
const convertToDisplayPermission = (permission: Permission): PermissionForDisplay => {
  const category = getPermissionCategory(permission.category);
  return {
    category: permission.category,
    name:
      category?.name ?? permission.category.charAt(0).toUpperCase() + permission.category.slice(1),
    description: category?.description ?? permission.purpose,
    riskLevel: category?.riskLevel ?? "medium",
    functions: permission.functions,
    purpose: permission.purpose,
  };
};

const getFunctionBadgeVariant = (func: FunctionPermission) => {
  if (func.isDeclared && func.isDetected) {
    return "default"; // Declared and detected
  } else if (!func.isDeclared && func.isDetected) {
    return "destructive"; // Detected but not declared (security concern)
  }
  return "outline"; // Fallback (declared but not detected)
};

export function PermissionCategoriesDisplay({ permissions }: PermissionCategoriesDisplayProps) {
  const { t } = useTranslation();

  // Hide implicit baseline capabilities (ui/query/toast/logger/storage) — they
  // carry no user-data or external-access risk and are not consented, so legacy
  // manifests that still declare them must not render stray badges here.
  const consentedPermissions = permissions.filter((p) => !isBaselineCategory(p.category));

  if (consentedPermissions.length === 0) {
    return (
      <div className="text-muted-foreground bg-muted/30 rounded-lg p-3 text-sm">
        {t("settings:addon_permission_none_detected")}
      </div>
    );
  }

  // Convert SDK permissions to display format
  const displayPermissions = consentedPermissions.map(convertToDisplayPermission);

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <h4 className="font-medium">{t("settings:addon_permission_list_title")}</h4>
        <div className="max-h-[400px] space-y-2 overflow-y-auto pr-2">
          {displayPermissions.map((permission) => (
            <div
              key={permission.category}
              className="bg-muted/30 flex items-start gap-3 rounded-lg p-3"
            >
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{permission.name}</span>
                </div>
                <p className="text-muted-foreground text-xs">{permission.description}</p>
                {permission.functions.length > 0 && (
                  <div className="mt-2 space-y-2">
                    <div className="flex flex-wrap gap-1">
                      {permission.functions.map((func: FunctionPermission) => (
                        <Badge
                          key={func.name}
                          variant={getFunctionBadgeVariant(func)}
                          className="text-xs font-light"
                          title={func.name} // Show technical name on hover
                        >
                          {getFunctionDisplayName(permission.category, func.name)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
