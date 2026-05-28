import { zodResolver } from "@hookform/resolvers/zod";
import { useIsMobileViewport } from "@/hooks/use-platform";
import type { FundManager } from "@/lib/types";
import { useForm } from "react-hook-form";
import * as z from "zod";

import { usePrivateAssetMutations } from "../use-private-asset-mutations";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Dialog, DialogContent } from "@wealthfolio/ui/components/ui/dialog";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";

const fundManagerSchema = z.object({
  name: z.string().trim().min(1, "Manager name is required"),
  notes: z.string().optional(),
});

type FundManagerFormValues = z.infer<typeof fundManagerSchema>;

interface FundManagerEditModalProps {
  fundManager?: FundManager | null;
  open: boolean;
  onClose: () => void;
  onSaved?: (manager: FundManager) => void;
}

export function FundManagerEditModal({
  fundManager,
  open,
  onClose,
  onSaved,
}: FundManagerEditModalProps) {
  const { fundManagerMutation, updateFundManagerMutation } = usePrivateAssetMutations();

  const form = useForm<FundManagerFormValues>({
    resolver: zodResolver(fundManagerSchema),
    values: {
      name: fundManager?.name ?? "",
      notes: fundManager?.notes ?? "",
    },
  });

  const isPending = fundManagerMutation.isPending || updateFundManagerMutation.isPending;

  const handleSubmit = async (values: FundManagerFormValues) => {
    const payload = {
      name: values.name.trim(),
      notes: values.notes?.trim() ? values.notes.trim() : null,
    };

    const saved = fundManager?.id
      ? await updateFundManagerMutation.mutateAsync({
          fundManagerId: fundManager.id,
          payload,
        })
      : await fundManagerMutation.mutateAsync(payload);

    onSaved?.(saved);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      useIsMobile={useIsMobileViewport}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
            <DialogHeader>
              <DialogTitle>
                {fundManager?.id ? "Edit Fund Manager" : "Add Fund Manager"}
              </DialogTitle>
              <DialogDescription>
                Keep manager records first-class so private assets can select them instead of
                storing free-form labels.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Manager Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. HarbourVest Partners" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={4}
                        placeholder="Optional context about this manager"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? (
                  <span className="flex items-center gap-2">
                    <Icons.Spinner className="h-4 w-4 animate-spin" />
                    Saving
                  </span>
                ) : fundManager?.id ? (
                  "Save changes"
                ) : (
                  "Create manager"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
