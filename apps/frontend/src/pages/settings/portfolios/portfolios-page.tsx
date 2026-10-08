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
import { Avatar, AvatarFallback } from "@wealthfolio/ui/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { Button, EmptyPlaceholder, Icons, Separator, Skeleton } from "@wealthfolio/ui";
import { PortfolioDialog } from "./portfolio-dialog";
import { SettingsHeader } from "../settings-header";

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
          heading={t("settings:portfolios.title")}
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
              <Icons.Plus className="mr-2 h-4 w-4" />
              {t("settings:portfolios.add_button")}
            </Button>
          </>
        </SettingsHeader>
        <Separator />

        {portfolios.length === 0 ? (
          <EmptyPlaceholder>
            <EmptyPlaceholder.Icon name="Folder" />
            <EmptyPlaceholder.Title>{t("settings:portfolios.empty_title")}</EmptyPlaceholder.Title>
            <EmptyPlaceholder.Description>
              {t("settings:portfolios.empty_description")}
            </EmptyPlaceholder.Description>
            <Button onClick={openCreate}>
              <Icons.Plus className="mr-2 h-4 w-4" />
              {t("settings:portfolios.add_first")}
            </Button>
          </EmptyPlaceholder>
        ) : (
          <div className="divide-border bg-card divide-y rounded-md border">
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
                      <DropdownMenuTrigger className="hover:bg-muted flex h-8 w-8 items-center justify-center rounded-md border transition-colors">
                        <Icons.MoreVertical className="h-4 w-4" />
                        <span className="sr-only">{t("settings:portfolios.operations_open")}</span>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(p)}>
                          {t("common:edit")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive flex cursor-pointer items-center"
                          onSelect={() => setDeleting(p)}
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
        onSave={(data) => {
          if (editing) {
            updateMutation.mutate({ ...editing, ...data }, { onSuccess: () => setOpen(false) });
          } else {
            createMutation.mutate(data as NewPortfolio, { onSuccess: () => setOpen(false) });
          }
        }}
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
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={handleDelete}
            >
              <Icons.Trash className="mr-2 h-4 w-4" />
              {t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
