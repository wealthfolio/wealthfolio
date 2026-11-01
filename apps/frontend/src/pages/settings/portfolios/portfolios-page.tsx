import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAccounts } from "@/hooks/use-accounts";
import { usePortfolioMutations, usePortfolios } from "@/hooks/use-portfolios";
import type { NewPortfolio, PortfolioWithAccounts } from "@/lib/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Avatar, AvatarFallback } from "@wealthfolio/ui/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import {
  Button,
  Checkbox,
  Icons,
  Separator,
  Skeleton,
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@wealthfolio/ui";
import { SettingsHeader } from "../settings-header";
import { Alert, AlertDescription, AlertTitle } from "@wealthfolio/ui/components/ui/alert";
import { cardSurfaceClassName } from "@wealthfolio/ui/components/ui/card";
import { cn } from "@/lib/utils";

export default function PortfoliosPage() {
  const { t } = useTranslation();
  const { data: portfolios = [], isLoading } = usePortfolios();
  const { accounts, isLoading: isAccountsLoading } = useAccounts({
    filterActive: false,
    includeArchived: true,
  });
  const { createMutation, updateMutation, deleteMutation } = usePortfolioMutations();
  const existingAccountIds = useMemo(
    () => new Set(accounts.map((account) => account.id)),
    [accounts],
  );

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PortfolioWithAccounts | null>(null);
  const [deleting, setDeleting] = useState<PortfolioWithAccounts | null>(null);

  // Closes once the save itself ends rather than from a callback passed to
  // mutate(): React Query skips those while a phone screen is out of sight,
  // which left the dialog open, ready to save the portfolio a second time.
  const savePortfolio = async (
    data: NewPortfolio | Omit<PortfolioWithAccounts, "createdAt" | "updatedAt">,
  ) => {
    try {
      if (editing) await updateMutation.mutateAsync({ ...editing, ...data });
      else await createMutation.mutateAsync(data as NewPortfolio);
      setOpen(false);
    } catch {
      // The mutation reports the error; the dialog stays open to try again.
    }
  };

  const openCreate = () => {
    setEditing(null);
    setOpen(true);
  };

  const openEdit = (p: PortfolioWithAccounts) => {
    setEditing(p);
    setOpen(true);
  };

  const handleDelete = () => {
    if (!deleting) return;
    deleteMutation.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
  };

  if (isLoading || isAccountsLoading) {
    return (
      <div>
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <SettingsHeader
          heading={t("settings:nav.items.portfolios")}
          text={t("settings:portfolios.description")}
          actionsInline
        >
          <>
            <Button
              size="icon"
              className="sm:hidden"
              onClick={openCreate}
              aria-label={t("settings:portfolios.add_aria")}
            >
              <Icons.Plus className="h-4 w-4" />
            </Button>
            <Button size="sm" className="hidden sm:inline-flex" onClick={openCreate}>
              <Icons.Plus className="me-2 h-4 w-4" />
              {t("settings:portfolios.add_button")}
            </Button>
          </>
        </SettingsHeader>
        <Separator />

        {portfolios.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icons.Folder />
              </EmptyMedia>
              <EmptyTitle>{t("settings:portfolios.empty_title")}</EmptyTitle>
              <EmptyDescription>{t("settings:portfolios.empty_description")}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={openCreate}>
                <Icons.Plus className="me-2 h-4 w-4" />
                {t("settings:portfolios.add_first")}
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className={cn(cardSurfaceClassName, "divide-border divide-y")}>
            {portfolios.map((p) => {
              const missingAccountCount = p.accountIds.filter(
                (id) => !existingAccountIds.has(id),
              ).length;
              const existingAccountCount = p.accountIds.length - missingAccountCount;

              return (
                <div key={p.id} className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10 rounded-lg">
                      <AvatarFallback className="rounded-lg bg-violet-500/10">
                        <Icons.Folder className="h-5 w-5 text-violet-500" />
                      </AvatarFallback>
                    </Avatar>

                    <div className="grid gap-1">
                      <div className="flex items-center gap-2 font-semibold">
                        <span>{p.name}</span>
                        {missingAccountCount > 0 && (
                          <Icons.AlertTriangle
                            className="text-warning h-4 w-4"
                            aria-label={t("settings:portfolios.deleted_links_aria")}
                          />
                        )}
                      </div>
                      <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
                        <span>
                          {t("settings:portfolios.account_count", {
                            count: existingAccountCount,
                          })}
                        </span>
                        {missingAccountCount > 0 && (
                          <>
                            <span>·</span>
                            <span className="text-warning">
                              {t("settings:portfolios.deleted_link_count", {
                                count: missingAccountCount,
                              })}
                            </span>
                          </>
                        )}
                        {p.description && (
                          <>
                            <span>·</span>
                            <span className="truncate">{p.description}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2">
                    <DropdownMenu>
                      {/* Named by aria-label, as in account operations: an sr-only span
                          here is placed against the settings shell (#2252). */}
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-xs" />}
                        aria-label={t("settings:portfolios.operations_open")}
                      >
                        <Icons.MoreVertical className="h-4 w-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(p)}>
                          {t("common:edit")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive flex cursor-pointer items-center"
                          onClick={() => setDeleting(p)}
                        >
                          {t("common:delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* key resets form state when switching between portfolios or opening fresh */}
      <PortfolioDialog
        key={editing?.id ?? "new"}
        open={open}
        portfolio={editing}
        accountOptions={accounts}
        onClose={() => setOpen(false)}
        onSave={(data) => void savePortfolio(data)}
        isSaving={createMutation.isPending || updateMutation.isPending}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(value) => !value && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings:portfolios.delete_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? t("settings:portfolios.delete_description_named", { name: deleting.name })
                : t("settings:portfolios.delete_description_generic")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={handleDelete}
            >
              <Icons.Trash className="me-2 h-4 w-4" />
              {t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface PortfolioDialogProps {
  open: boolean;
  portfolio: PortfolioWithAccounts | null;
  accountOptions: { id: string; name: string; currency: string }[];
  onClose: () => void;
  onSave: (data: NewPortfolio | Omit<PortfolioWithAccounts, "createdAt" | "updatedAt">) => void;
  isSaving: boolean;
}

function PortfolioDialog({
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
            <Label>{t("common:accounts")}</Label>
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
              <Alert variant="warning" className="p-3 text-xs">
                <Icons.AlertTriangle className="size-3.5" />
                <AlertTitle>{t("settings:portfolios.remove_deleted_links")}</AlertTitle>
                <AlertDescription className="mt-1 space-y-1">
                  {missingAccountIds.map((id) => (
                    <div key={id} className="break-all">
                      {t("settings:portfolios.deleted_account", { id })}
                    </div>
                  ))}
                </AlertDescription>
              </Alert>
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
