import { useState } from "react";
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
import { Button, Checkbox, EmptyPlaceholder, Icons, Separator, Skeleton } from "@wealthfolio/ui";
import { SettingsHeader } from "../settings-header";

export default function PortfoliosPage() {
  const { data: portfolios = [], isLoading } = usePortfolios();
  const { accounts } = useAccounts({ filterActive: false, includeArchived: false });
  const { createMutation, updateMutation, deleteMutation } = usePortfolioMutations();

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

  if (isLoading) {
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
        <SettingsHeader heading="Portfolios" text="Create named reporting scopes across accounts.">
          <>
            <Button
              size="icon"
              className="sm:hidden"
              onClick={openCreate}
              aria-label="Add portfolio"
            >
              <Icons.Plus className="h-4 w-4" />
            </Button>
            <Button size="sm" className="hidden sm:inline-flex" onClick={openCreate}>
              <Icons.Plus className="mr-2 h-4 w-4" />
              Add portfolio
            </Button>
          </>
        </SettingsHeader>
        <Separator />

        {portfolios.length === 0 ? (
          <EmptyPlaceholder>
            <EmptyPlaceholder.Icon name="Folder" />
            <EmptyPlaceholder.Title>No portfolios yet</EmptyPlaceholder.Title>
            <EmptyPlaceholder.Description>
              Group accounts into named reporting scopes to filter performance, holdings, income,
              and activities.
            </EmptyPlaceholder.Description>
            <Button onClick={openCreate}>
              <Icons.Plus className="mr-2 h-4 w-4" />
              Add a portfolio
            </Button>
          </EmptyPlaceholder>
        ) : (
          <div className="divide-border bg-card divide-y rounded-md border">
            {portfolios.map((p) => (
              <div key={p.id} className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <Avatar className="h-10 w-10 rounded-lg">
                    <AvatarFallback className="rounded-lg bg-violet-500/10">
                      <Icons.Folder className="h-5 w-5 text-violet-500" />
                    </AvatarFallback>
                  </Avatar>

                  <div className="grid gap-1">
                    <div className="font-semibold">{p.name}</div>
                    <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
                      <span>
                        {p.accountIds.length} account{p.accountIds.length !== 1 ? "s" : ""}
                      </span>
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
                      <span className="sr-only">Open</span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(p)}>Edit</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive flex cursor-pointer items-center"
                        onSelect={() => setDeleting(p)}
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
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
            <AlertDialogTitle>Delete portfolio?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes {deleting ? `"${deleting.name}"` : "this portfolio"} and its account
              memberships. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={handleDelete}
            >
              <Icons.Trash className="mr-2 h-4 w-4" />
              Delete
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
  const [name, setName] = useState(portfolio?.name ?? "");
  const [description, setDescription] = useState(portfolio?.description ?? "");
  const [selectedIds, setSelectedIds] = useState<string[]>(portfolio?.accountIds ?? []);

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
          <DialogTitle>{portfolio ? "Edit portfolio" : "New portfolio"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label htmlFor="portfolio-name">Name</Label>
            <Input
              id="portfolio-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Retirement"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="portfolio-description">Description (optional)</Label>
            <Textarea
              id="portfolio-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="e.g. IRA + Roth IRA + 401k"
            />
          </div>

          <div className="space-y-2">
            <Label>Accounts</Label>
            <div className="divide-border max-h-56 overflow-y-auto rounded-md border">
              {accountOptions.length === 0 ? (
                <p className="text-muted-foreground p-3 text-sm">No accounts found.</p>
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
              <p className="text-destructive text-xs">Select at least one account.</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || isSaving}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
