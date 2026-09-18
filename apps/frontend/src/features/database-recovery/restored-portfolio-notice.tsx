import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSettingsContext } from "@/lib/settings-provider";

/** Mounted behind database readiness; the restored database owns this flag. */
export function RestoredPortfolioNotice() {
  const { settings } = useSettingsContext();
  const { t } = useTranslation();
  const reconnect = settings?.restoreReconnectRequired;
  useEffect(() => {
    if (!reconnect) return;
    const id = "restored-portfolio";
    toast.info(t("settings:backup_restored_title"), {
      id,
      description: t("settings:backup_import_reconnect"),
      duration: Infinity,
    });
    // Dismissal is presentation only. The backend clears the flag on reconnect.
    return () => {
      toast.dismiss(id);
    };
  }, [reconnect, t]);
  return null;
}
