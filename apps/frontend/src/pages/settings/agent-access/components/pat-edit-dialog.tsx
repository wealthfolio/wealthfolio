import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentAccessToken } from "@/adapters";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { applyScopeDependencies, type ScopeKey } from "../scopes";
import { ScopeSelector } from "./scope-selector";

interface PatEditDialogProps {
  token: AgentAccessToken;
  onClose: () => void;
  onSave: (scopes: string[]) => Promise<unknown>;
  isSaving: boolean;
}

export function PatEditDialog({ token, onClose, onSave, isSaving }: PatEditDialogProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(() => new Set(token.scopes));
  const scopes = applyScopeDependencies(selected);
  const toggleScope = (key: ScopeKey) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const save = async () => {
    try {
      await onSave(scopes);
      onClose();
    } catch {
      // The mutation shows the error; preserve the user's selection.
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogTitle>{t("settings:agentAccess.edit_title", { name: token.name })}</DialogTitle>
        <DialogDescription>{t("settings:agentAccess.edit_description")}</DialogDescription>
        <ScopeSelector selectedScopes={scopes} onToggle={toggleScope} disabled={isSaving} onSelectPreset={(scopes) => setSelected(new Set(scopes))} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={isSaving} onClick={onClose}>
            {t("common:cancel")}
          </Button>
          <Button disabled={isSaving || scopes.length === 0} onClick={() => void save()}>
            {t("common:save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
