// Flow notes
// Quiet reassurance at the bottom of steps that need nothing from the user.
// ==========================================================================

import { Icons } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

/** Shown while data moves between devices. */
export function EncryptedNote() {
  const { t } = useTranslation();
  return (
    <>
      <Icons.Lock className="size-3.5 shrink-0" aria-hidden />
      {t("sync:wizard.encryptedNote")}
    </>
  );
}

/** Shown while a restore works; hiding the window never stops it. */
export function BackgroundNote() {
  const { t } = useTranslation();
  return (
    <>
      <Icons.Clock className="size-3.5 shrink-0" aria-hidden />
      {t("sync:wizard.backgroundNote")}
    </>
  );
}
