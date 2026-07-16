import { Column } from "@tanstack/react-table";
import { Button } from "../button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";

import { Icons } from "../icons";

import { cn } from "../../../lib/utils";
import { useTranslation } from "react-i18next";

interface DataTableColumnHeaderProps<TData, TValue> extends React.HTMLAttributes<HTMLDivElement> {
  column: Column<TData, TValue>;
  title: string;
}

export function DataTableColumnHeader<TData, TValue>({
  column,
  title,
  className,
}: DataTableColumnHeaderProps<TData, TValue>) {
  const { t } = useTranslation();
  if (!column.getCanSort()) {
    return <div className={cn(className)}>{title}</div>;
  }

  return (
    <div className={cn("flex items-center space-x-2", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="data-[state=open]:bg-accent -ml-3 h-8">
            <span>{title}</span>
            {column.getIsSorted() === "desc" ? (
              <Icons.ArrowDown className="ml-2 h-4 w-4" />
            ) : column.getIsSorted() === "asc" ? (
              <Icons.ArrowUp className="ml-2 h-4 w-4" />
            ) : // <Icons.ChevronsUpDown className="ml-2 h-4 w-4" />
            null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => column.toggleSorting(false)}>
            <Icons.ArrowUp className="text-muted-foreground/70 mr-2 h-3.5 w-3.5" />
            {t("ui:dataTable.sortAsc", "Asc")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => column.toggleSorting(true)}>
            <Icons.ArrowDown className="text-muted-foreground/70 mr-2 h-3.5 w-3.5" />
            {t("ui:dataTable.sortDesc", "Desc")}
          </DropdownMenuItem>
          {!!column.getCanHide() && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => column.toggleVisibility(false)}>
                <Icons.EyeOff className="text-muted-foreground/70 mr-2 h-3.5 w-3.5" />
                {t("ui:dataTable.hide", "Hide")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
