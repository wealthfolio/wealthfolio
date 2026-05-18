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
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
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

  return (
    <>
      <SettingsHeader heading="Portfolios" text="Create named reporting scopes across accounts.">
        <Button onClick={openCreate}>
          <Icons.Plus className="mr-2 h-4 w-4" />
          Add portfolio
        </Button>
      </SettingsHeader>

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : portfolios.length === 0 ? (
        <p className="text-muted-foreground text-sm">No portfolios yet.</p>
      ) : (
        <div className="divide-border divide-y rounded-lg border">
          {portfolios.map((p) => (
            <div key={p.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="font-medium">{p.name}</p>
                <p className="text-muted-foreground text-xs">
                  {p.accountIds.length} account{p.accountIds.length !== 1 ? "s" : ""}
                  {p.description ? ` · ${p.description}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="icon" onClick={() => openEdit(p)}>
                  <Icons.Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setDeleting(p)}
                  disabled={deleteMutation.isPending}
                >
                  <Icons.Trash className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

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
