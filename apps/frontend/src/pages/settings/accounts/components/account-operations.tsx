import { useState } from "react";

import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { Icons } from "@wealthfolio/ui/components/ui/icons";

import type { Account } from "@/lib/types";
import { useI18n } from "@/i18n/i18n-provider";

export interface AccountOperationsProps {
  account: Account;
  onEdit: (account: Account) => void | undefined;
  onDelete: (account: Account) => void | undefined;
  onArchive: (account: Account, archive: boolean) => void | undefined;
  onHide: (account: Account, hide: boolean) => void | undefined;
}

export function AccountOperations({
  account,
  onEdit,
  onDelete,
  onArchive,
  onHide,
}: AccountOperationsProps) {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const [showDeleteAlert, setShowDeleteAlert] = useState(false);
  const [showArchiveAlert, setShowArchiveAlert] = useState(false);

  const handleDelete = () => {
    onDelete(account);
    setShowDeleteAlert(false);
  };

  const handleArchive = () => {
    onArchive(account, true);
    setShowArchiveAlert(false);
  };

  const handleRestore = () => {
    onArchive(account, false);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="hover:bg-muted flex h-8 w-8 items-center justify-center rounded-md border transition-colors">
          <Icons.MoreVertical className="h-4 w-4" />
          <span className="sr-only">{isChinese ? "打开" : "Open"}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onEdit(account)}>
            {isChinese ? "编辑" : "Edit"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onHide(account, account.isActive)}>
            {account.isActive ? (isChinese ? "隐藏" : "Hide") : isChinese ? "显示" : "Show"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {account.isArchived ? (
            <DropdownMenuItem onClick={handleRestore}>
              {isChinese ? "恢复" : "Restore"}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => setShowArchiveAlert(true)}>
              {isChinese ? "归档" : "Archive"}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className="text-destructive focus:text-destructive flex cursor-pointer items-center"
            onSelect={() => setShowDeleteAlert(true)}
          >
            {isChinese ? "删除" : "Delete"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteAlert} onOpenChange={setShowDeleteAlert}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isChinese
                ? "确定要删除此账户及相关活动吗？"
                : "Are you sure you want to delete this account and related activities?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isChinese ? "此操作无法撤销。" : "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isChinese ? "取消" : "Cancel"}</AlertDialogCancel>
            <Button onClick={handleDelete} className="bg-red-600 focus:ring-red-600">
              <Icons.Trash className="mr-2 h-4 w-4" />
              <span>{isChinese ? "删除" : "Delete"}</span>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Archive Confirmation Dialog */}
      <AlertDialog open={showArchiveAlert} onOpenChange={setShowArchiveAlert}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Icons.AlertTriangle className="h-5 w-5 text-amber-500" />
              {isChinese ? "要归档此账户吗？" : "Archive this account?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isChinese
                ? "归档后，此账户会从总投资组合历史和净资产计算中移除。历史图表将不再包含该账户数据并重新计算。你之后可以恢复它。"
                : "Archiving will remove this account from your Total Portfolio history and net worth calculations. Historical charts will be recalculated without this account's data. You can restore it later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isChinese ? "取消" : "Cancel"}</AlertDialogCancel>
            <Button onClick={handleArchive}>{isChinese ? "归档" : "Archive"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
