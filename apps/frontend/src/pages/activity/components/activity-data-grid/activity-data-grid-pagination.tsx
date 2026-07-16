import {
  Button,
  Icons,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui";
import { KeyboardEvent, useState } from "react";
import { useTranslation } from "react-i18next";

interface ActivityDataGridPaginationProps {
  pageIndex: number;
  pageSize: number;
  pageCount: number;
  totalRowCount: number;
  isFetching: boolean;
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

export function ActivityDataGridPagination({
  pageIndex,
  pageSize,
  pageCount,
  totalRowCount,
  isFetching,
  onPageChange,
  onPageSizeChange,
}: ActivityDataGridPaginationProps) {
  const { t } = useTranslation();
  const [pageInput, setPageInput] = useState<string>("");

  const currentPage = pageIndex + 1;
  const startRow = totalRowCount === 0 ? 0 : pageIndex * pageSize + 1;
  const endRow = Math.min((pageIndex + 1) * pageSize, totalRowCount);

  const canPreviousPage = pageIndex > 0;
  const canNextPage = pageIndex < pageCount - 1;

  const handleJumpToPage = (inputValue: string) => {
    const page = parseInt(inputValue);
    if (!isNaN(page) && page >= 1 && page <= pageCount) {
      onPageChange(page - 1);
      setPageInput("");
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleJumpToPage(pageInput);
    } else if (e.key === "Escape") {
      setPageInput("");
    }
  };

  const handleBlur = () => {
    if (pageInput) {
      handleJumpToPage(pageInput);
    }
  };

  // Prevent mousedown from bubbling to document, which would clear DataGrid selection
  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <div
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      onMouseDown={handleMouseDown}
    >
      {/* Results count */}
      <div className="text-muted-foreground flex items-center gap-2 text-center text-xs sm:text-left">
        {isFetching && <Icons.Spinner className="h-3.5 w-3.5 animate-spin" />}
        {totalRowCount === 0 ? (
          <span>{t("activity:datagrid.pagination.no_activities")}</span>
        ) : (
          <span>
            <span className="hidden sm:inline">{t("activity:datagrid.pagination.showing")} </span>
            <span className="text-foreground font-medium">{startRow}</span>
            <span className="hidden sm:inline"> {t("activity:datagrid.pagination.to")} </span>
            <span className="sm:hidden">-</span>
            <span className="text-foreground font-medium">{endRow}</span>
            <span className="hidden sm:inline"> {t("activity:datagrid.pagination.of")} </span>
            <span className="sm:hidden"> / </span>
            <span className="text-foreground font-medium">{totalRowCount}</span>
            <span className="hidden sm:inline">
              {" "}
              {t("activity:datagrid.pagination.activities")}
            </span>
          </span>
        )}
      </div>

      {/* Controls container */}
      <div className="flex flex-wrap items-center justify-center gap-2 sm:flex-nowrap sm:gap-4">
        {/* Rows per page selector */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">
            <span className="hidden sm:inline">
              {t("activity:datagrid.pagination.rows_per_page")}
            </span>
            <span className="sm:hidden">{t("activity:datagrid.pagination.show")}</span>
          </span>
          <Select
            value={`${pageSize}`}
            onValueChange={(value) => {
              onPageSizeChange(Number(value));
            }}
          >
            <SelectTrigger className="h-7 w-[65px] text-xs">
              <SelectValue placeholder={pageSize} />
            </SelectTrigger>
            <SelectContent side="top">
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={`${size}`}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Jump to page input */}
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min={1}
            max={pageCount}
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder={`${currentPage}`}
            className="h-7 w-[50px] text-center text-xs"
            title={t("activity:datagrid.pagination.jump_hint", { count: pageCount })}
          />
          <span className="text-muted-foreground whitespace-nowrap text-xs">
            <span className="hidden sm:inline">{t("activity:datagrid.pagination.of")}</span>
            <span className="sm:hidden">/</span> {pageCount || 1}
          </span>
        </div>

        {/* Navigation buttons */}
        <div className="flex items-center gap-0.5">
          {/* First page */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden h-7 w-7 sm:flex"
            onClick={() => onPageChange(0)}
            disabled={!canPreviousPage || isFetching}
            title={t("activity:datagrid.pagination.first_page")}
          >
            <span className="sr-only">{t("activity:datagrid.pagination.first_page")}</span>
            <Icons.ChevronsLeft className="h-3.5 w-3.5" />
          </Button>
          {/* Previous page */}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onPageChange(pageIndex - 1)}
            disabled={!canPreviousPage || isFetching}
            title={t("activity:datagrid.pagination.previous_page")}
          >
            <span className="sr-only">{t("activity:datagrid.pagination.previous_page")}</span>
            <Icons.ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          {/* Next page */}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onPageChange(pageIndex + 1)}
            disabled={!canNextPage || isFetching}
            title={t("activity:datagrid.pagination.next_page")}
          >
            <span className="sr-only">{t("activity:datagrid.pagination.next_page")}</span>
            <Icons.ChevronRight className="h-3.5 w-3.5" />
          </Button>
          {/* Last page */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden h-7 w-7 sm:flex"
            onClick={() => onPageChange(pageCount - 1)}
            disabled={!canNextPage || isFetching}
            title={t("activity:datagrid.pagination.last_page")}
          >
            <span className="sr-only">{t("activity:datagrid.pagination.last_page")}</span>
            <Icons.ChevronsRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
