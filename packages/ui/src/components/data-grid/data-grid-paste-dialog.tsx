"use client";

import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import type { TableMeta } from "@tanstack/react-table";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import type { PasteDialogState } from "./data-grid-types";

interface DataGridPasteDialogProps<TData> {
  tableMeta: TableMeta<TData>;
  pasteDialog: PasteDialogState;
}

export function DataGridPasteDialog<TData>({ tableMeta, pasteDialog }: DataGridPasteDialogProps<TData>) {
  const onPasteDialogOpenChange = tableMeta?.onPasteDialogOpenChange;
  const onPasteWithExpansion = tableMeta?.onPasteWithExpansion;
  const onPasteWithoutExpansion = tableMeta?.onPasteWithoutExpansion;

  if (!pasteDialog.open) return null;

  return (
    <PasteDialog
      pasteDialog={pasteDialog}
      onPasteDialogOpenChange={onPasteDialogOpenChange}
      onPasteWithExpansion={onPasteWithExpansion}
      onPasteWithoutExpansion={onPasteWithoutExpansion}
    />
  );
}

interface PasteDialogProps
  extends
    Pick<TableMeta<unknown>, "onPasteDialogOpenChange" | "onPasteWithExpansion" | "onPasteWithoutExpansion">,
    Required<Pick<TableMeta<unknown>, "pasteDialog">> {}

const PasteDialog = React.memo(PasteDialogImpl, (prev, next) => {
  if (prev.pasteDialog.open !== next.pasteDialog.open) return false;
  if (!next.pasteDialog.open) return true;
  if (prev.pasteDialog.rowsNeeded !== next.pasteDialog.rowsNeeded) return false;

  return true;
});

function PasteDialogImpl({
  pasteDialog,
  onPasteDialogOpenChange,
  onPasteWithExpansion,
  onPasteWithoutExpansion,
}: PasteDialogProps) {
  const { t } = useTranslation();
  const expandRadioRef = React.useRef<HTMLInputElement | null>(null);

  const onCancel = React.useCallback(() => {
    onPasteDialogOpenChange?.(false);
  }, [onPasteDialogOpenChange]);

  const onContinue = React.useCallback(() => {
    if (expandRadioRef.current?.checked) {
      onPasteWithExpansion?.();
    } else {
      onPasteWithoutExpansion?.();
    }
  }, [onPasteWithExpansion, onPasteWithoutExpansion]);

  return (
    <Dialog open={pasteDialog.open} onOpenChange={onPasteDialogOpenChange}>
      <DialogContent data-grid-popover="">
        <DialogHeader>
          <DialogTitle>{t("ui:dialog.addRowsTitle", "Do you want to add more rows?")}</DialogTitle>
          <DialogDescription>
            {t(
              "ui:dialog.addRowsDescription",
              "We need {{count}} additional row to paste everything from your clipboard.",
              { count: pasteDialog.rowsNeeded },
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          <label className="flex cursor-pointer items-start gap-3">
            <RadioItem ref={expandRadioRef} name="expand-option" value="expand" defaultChecked />
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium leading-none">
                {t("ui:dialog.createNewRows", "Create new rows")}
              </span>
              <span className="text-muted-foreground text-sm">
                {t("ui:dialog.createNewRowsDescription", "Add {{count}} new row to the table and paste all data", {
                  count: pasteDialog.rowsNeeded,
                })}
              </span>
            </div>
          </label>
          <label className="flex cursor-pointer items-start gap-3">
            <RadioItem name="expand-option" value="no-expand" />
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium leading-none">
                {t("ui:dialog.keepCurrentRows", "Keep current rows")}
              </span>
              <span className="text-muted-foreground text-sm">
                {t("ui:dialog.keepCurrentRowsDescription", "Paste only what fits in the existing rows")}
              </span>
            </div>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("ui:dialog.cancel", "Cancel")}
          </Button>
          <Button onClick={onContinue}>{t("ui:dialog.continue", "Continue")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RadioItem({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="radio"
      className={cn(
        "border-input bg-background shadow-xs relative size-4 shrink-0 appearance-none rounded-full border outline-none transition-[color,box-shadow]",
        "text-primary focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "checked:before:bg-primary checked:before:absolute checked:before:start-1/2 checked:before:top-1/2 checked:before:size-2 checked:before:-translate-x-1/2 checked:before:-translate-y-1/2 checked:before:rounded-full checked:before:content-['']",
        "dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}
