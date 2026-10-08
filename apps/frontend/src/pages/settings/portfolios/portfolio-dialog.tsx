import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NewPortfolio, PortfolioWithAccounts } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import { Button, Checkbox, Icons } from "@wealthfolio/ui";

interface PortfolioDialogProps {
  open: boolean;
  portfolio: PortfolioWithAccounts | null;
  accountOptions: { id: string; name: string; currency: string }[];
  onClose: () => void;
  onSave: (data: NewPortfolio | Omit<PortfolioWithAccounts, "createdAt" | "updatedAt">) => void;
  isSaving: boolean;
}

export function PortfolioDialog({
  open,
  portfolio,
  accountOptions,
  onClose,
  onSave,
  isSaving,
}: PortfolioDialogProps) {
  const { t } = useTranslation();
  const existingAccountIds = useMemo(
    () => new Set(accountOptions.map((account) => account.id)),
    [accountOptions],
  );
  const missingAccountIds = useMemo(
    () => portfolio?.accountIds.filter((id) => !existingAccountIds.has(id)) ?? [],
    [existingAccountIds, portfolio],
  );
  const [name, setName] = useState(portfolio?.name ?? "");
  const [description, setDescription] = useState(portfolio?.description ?? "");
  const [selectedIds, setSelectedIds] = useState<string[]>(
    portfolio?.accountIds.filter((id) => existingAccountIds.has(id)) ?? [],
  );

  const toggle = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const canSave = name.trim().length > 0 && selectedIds.length > 0;

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      name: name.trim(),
      description: description.trim() || undefined,
      accountIds: selectedIds,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {portfolio
              ? t("settings:portfolios.dialog_edit_title")
              : t("settings:portfolios.dialog_new_title")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label htmlFor="portfolio-name">{t("settings:portfolios.name_label")}</Label>
            <Input
              id="portfolio-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("settings:portfolios.name_placeholder")}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="portfolio-description">
              {t("settings:portfolios.description_label")}
            </Label>
            <Textarea
              id="portfolio-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={t("settings:portfolios.description_placeholder")}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("settings:portfolios.accounts_label")}</Label>
            <div className="divide-border max-h-56 overflow-y-auto rounded-md border">
              {accountOptions.length === 0 ? (
                <p className="text-muted-foreground p-3 text-sm">
                  {t("settings:portfolios.no_accounts")}
                </p>
              ) : (
                accountOptions.map((a) => (
                  <label
                    key={a.id}
                    className="hover:bg-muted/40 flex cursor-pointer items-center gap-3 px-3 py-2"
                  >
                    <Checkbox
                      checked={selectedIds.includes(a.id)}
                      onCheckedChange={() => toggle(a.id)}
                    />
                    <span className="text-sm">
                      {a.name} <span className="text-muted-foreground text-xs">({a.currency})</span>
                    </span>
                  </label>
                ))
              )}
            </div>
            {selectedIds.length === 0 && (
              <p className="text-destructive text-xs">
                {t("settings:portfolios.select_one_account")}
              </p>
            )}
            {missingAccountIds.length > 0 && (
              <div className="border-warning/30 bg-warning/10 text-warning rounded-md border p-3 text-xs">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <Icons.AlertTriangle className="h-3.5 w-3.5" />
                  {t("settings:portfolios.remove_deleted_links")}
                </div>
                <div className="text-muted-foreground space-y-1">
                  {missingAccountIds.map((id) => (
                    <div key={id} className="break-all">
                      {t("settings:portfolios.deleted_account", { id })}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common:cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!canSave || isSaving}>
            {isSaving ? t("settings:portfolios.saving") : t("common:save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
