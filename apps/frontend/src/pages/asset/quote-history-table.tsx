import { Quote } from "@/lib/types";
import { format } from "date-fns";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { formatQuantity } from "@/lib/utils";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  RowData,
  SortingState,
  useReactTable,
} from "@tanstack/react-table";

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData extends RowData> {
    editingId?: string | null;
    editedValues?: Record<string, unknown>;
    handleInputChange?: (field: keyof Quote, value: string | Date, isNew?: boolean) => void;
    handleEdit?: (quote: Quote) => void;
    handleSave?: () => void;
    handleCancel?: () => void;
    handleDelete?: (quoteId: string) => void;
  }
}
import {
  Button,
  DatePickerInput,
  formatPrice,
  Icons,
  Input,
  Label,
  MoneyInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";

interface QuoteHistoryTableProps {
  data: Quote[];
  isManualDataSource?: boolean;
  onSaveQuote?: (quote: Quote) => void;
  onDeleteQuote?: (quoteId: string) => void;
  onChangeDataSource?: (isManual: boolean) => void;
}

const ITEMS_PER_PAGE = 10;

const emptyQuote: Partial<Quote> = {
  timestamp: new Date().toISOString(),
  open: 0,
  high: 0,
  low: 0,
  close: 0,
  volume: 0,
  adjclose: 0,
};

export const QuoteHistoryTable: React.FC<QuoteHistoryTableProps> = ({
  data,
  isManualDataSource = false,
  onSaveQuote,
  onDeleteQuote,
  onChangeDataSource,
}) => {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedValues, setEditedValues] = useState<Partial<Quote>>({});
  const [isAddingQuote, setIsAddingQuote] = useState(false);
  const [newQuote, setNewQuote] = useState<Partial<Quote>>(emptyQuote);
  const [sorting, setSorting] = useState<SortingState>([{ id: "timestamp", desc: true }]);

  useEffect(() => {
    if (isAddingQuote) {
      setNewQuote(emptyQuote);
    }
  }, [isAddingQuote]);

  // Define handlers before they are used in columns
  const handleEdit = useCallback((quote: Quote) => {
    setEditingId(quote.id);
    setEditedValues(quote);
  }, []);

  const handleSave = useCallback(() => {
    if (editingId && onSaveQuote && editedValues) {
      onSaveQuote({ ...editedValues } as Quote);
      setEditingId(null);
      setEditedValues({});
    }
  }, [editingId, onSaveQuote, editedValues]);

  const handleCancel = useCallback(() => {
    setEditingId(null);
    setEditedValues({});
  }, []);

  const handleInputChange = useCallback(
    (field: keyof Quote, value: string | Date, isNew = false) => {
      const setValue = field === "timestamp" ? (value as Date).toISOString() : value;

      if (isNew) {
        setNewQuote((prev) => ({
          ...prev,
          [field]: setValue,
        }));
      } else {
        setEditedValues((prev) => ({
          ...prev,
          [field]: setValue,
        }));
      }
    },
    [],
  );

  const handleAddNew = useCallback(() => {
    if (onSaveQuote) {
      onSaveQuote({ ...newQuote } as Quote);
      setIsAddingQuote(false);
      setNewQuote(emptyQuote);
    }
  }, [onSaveQuote, newQuote]);

  const handleDelete = useCallback(
    (quoteId: string) => {
      if (onDeleteQuote) {
        onDeleteQuote(quoteId);
      }
    },
    [onDeleteQuote],
  );

  // Define columns using ColumnHelper
  const columnHelper = createColumnHelper<Quote>();

  interface QuoteTableMeta {
    editingId: string | null;
    editedValues: Record<string, unknown> & {
      timestamp?: string | Date;
      open?: number | string;
      high?: number | string;
      low?: number | string;
      close?: number | string;
      volume?: number | string;
    };
    handleInputChange: (key: keyof Quote | "timestamp", value: unknown, isNewRow?: boolean) => void;
    handleEdit: (quote: Quote) => void;
    handleSave: () => void;
    handleCancel: () => void;
    handleDelete: (quoteId: string) => void;
  }

  const columns = useMemo(
    () => [
      columnHelper.accessor("timestamp", {
        header: t("asset:quoteTable.date"),
        cell: (info) => {
          const { editingId, editedValues, handleInputChange } = info.table.options
            .meta as QuoteTableMeta;
          const value = info.getValue();
          return editingId === info.row.original.id ? (
            <DatePickerInput
              value={new Date(editedValues.timestamp || "")}
              onChange={(date: Date | undefined) => date && handleInputChange("timestamp", date)}
            />
          ) : (
            format(new Date(value), "yyyy-MM-dd")
          );
        },
        enableSorting: true,
      }),
      columnHelper.accessor("open", {
        header: t("asset:quoteTable.open"),
        cell: (info) => {
          const { editingId, editedValues, handleInputChange } = info.table.options
            .meta as QuoteTableMeta;
          const value = info.getValue();
          return editingId === info.row.original.id ? (
            <MoneyInput
              value={editedValues.open}
              onChange={(e) => handleInputChange("open", e.target.value)}
            />
          ) : (
            formatPrice(value, info.row.original.currency, false)
          );
        },
        enableSorting: false,
      }),
      columnHelper.accessor("high", {
        header: t("asset:quoteTable.high"),
        cell: (info) => {
          const { editingId, editedValues, handleInputChange } = info.table.options
            .meta as QuoteTableMeta;
          const value = info.getValue();
          return editingId === info.row.original.id ? (
            <MoneyInput
              value={editedValues.high}
              onChange={(e) => handleInputChange("high", e.target.value)}
              autoFocus={true}
            />
          ) : (
            formatPrice(value, info.row.original.currency, false)
          );
        },
        enableSorting: false,
      }),
      columnHelper.accessor("low", {
        header: t("asset:quoteTable.low"),
        cell: (info) => {
          const { editingId, editedValues, handleInputChange } = info.table.options
            .meta as QuoteTableMeta;
          const value = info.getValue();
          return editingId === info.row.original.id ? (
            <MoneyInput
              value={editedValues.low}
              onChange={(e) => handleInputChange("low", e.target.value)}
            />
          ) : (
            formatPrice(value, info.row.original.currency, false)
          );
        },
        enableSorting: false,
      }),
      columnHelper.accessor("close", {
        header: t("asset:quoteTable.close"),
        cell: (info) => {
          const { editingId, editedValues, handleInputChange } = info.table.options
            .meta as QuoteTableMeta;
          const value = info.getValue();
          return editingId === info.row.original.id ? (
            <MoneyInput
              value={editedValues.close}
              onChange={(e) => handleInputChange("close", e.target.value)}
            />
          ) : (
            formatPrice(value, info.row.original.currency, false)
          );
        },
        enableSorting: false,
      }),
      columnHelper.accessor("volume", {
        header: t("asset:quoteTable.volume"),
        cell: (info) => {
          const { editingId, editedValues, handleInputChange } = info.table.options
            .meta as QuoteTableMeta;
          const value = info.getValue();
          return editingId === info.row.original.id ? (
            <MoneyInput
              value={editedValues.volume}
              onChange={(e) => handleInputChange("volume", e.target.value)}
            />
          ) : (
            formatQuantity(value)
          );
        },
        enableSorting: false,
      }),
      ...(isManualDataSource
        ? [
            columnHelper.display({
              id: "actions",
              header: t("asset:quoteTable.actions"),
              cell: (info) => {
                const { editingId, handleEdit, handleSave, handleCancel, handleDelete } = info.table
                  .options.meta as QuoteTableMeta;
                const quote = info.row.original;
                return editingId === quote.id ? (
                  <div className="flex space-x-2">
                    <Button variant="ghost" size="icon" onClick={handleSave} className="h-8 w-8">
                      <Icons.Check className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={handleCancel} className="h-8 w-8">
                      <Icons.Close className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex space-x-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(quote)}
                      className="h-8 w-8"
                    >
                      <Icons.Pencil className="h-4 w-4" />
                    </Button>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <Icons.Trash className="h-4 w-4" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent>
                        <div className="flex flex-col items-center space-y-2">
                          <h4 className="font-medium">{t("asset:quoteTable.delete_quote")}</h4>
                          <p className="text-muted-foreground text-center text-sm">
                            {t("asset:quoteTable.delete_quote_confirm")}
                          </p>
                          <div className="flex space-x-2">
                            <Button variant="ghost" size="sm">
                              {t("common:cancel")}
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => handleDelete(quote.id)}
                            >
                              {t("asset:quoteTable.delete")}
                            </Button>
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                );
              },
            }),
          ]
        : []),
    ],
    [isManualDataSource, handleInputChange, handleEdit, handleSave, handleCancel, handleDelete, t],
  );

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
    },
    meta: {
      editingId,
      editedValues,
      handleInputChange,
      handleEdit,
      handleSave,
      handleCancel,
      handleDelete,
    },
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: ITEMS_PER_PAGE,
      },
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    manualPagination: false,
  });

  return (
    <div className="space-y-4">
      <div className="">
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center space-x-2">
            {/* <h4 className="text-sm font-medium">Quote History</h4> */}
          </div>
          <div className="flex items-center space-x-4">
            <Popover>
              <PopoverTrigger asChild>
                <div className="flex items-center space-x-2">
                  <Switch id="manual-tracking" checked={isManualDataSource} />
                  <Label htmlFor="manual-tracking" className="cursor-pointer">
                    {t("asset:quoteTable.manual_tracking")}
                  </Label>
                </div>
              </PopoverTrigger>
              <PopoverContent className="w-[360px] p-4">
                <div className="space-y-4">
                  <h4 className="font-medium">{t("asset:quoteTable.change_tracking_mode")}</h4>
                  {isManualDataSource ? (
                    <>
                      <p className="text-muted-foreground text-sm">
                        {t("asset:quoteTable.to_auto_description")}
                      </p>
                      <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                        ⚠️ {t("asset:quoteTable.to_auto_warning")}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-muted-foreground text-sm">
                        {t("asset:quoteTable.to_manual_description")}
                      </p>
                      <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                        ⚠️ {t("asset:quoteTable.to_manual_warning")}
                      </p>
                    </>
                  )}
                  <div className="flex justify-end space-x-2">
                    <Button variant="ghost" size="sm">
                      {t("common:cancel")}
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => onChangeDataSource?.(!isManualDataSource)}
                    >
                      {t("asset:quoteTable.confirm_change")}
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            {isManualDataSource && (
              <div className="flex items-center gap-2">
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setIsAddingQuote(true)}
                  disabled={isAddingQuote}
                >
                  <Icons.PlusCircle className="mr-2 h-4 w-4" />
                  {t("asset:quoteTable.add_quote")}
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/market-data/import" className="flex items-center gap-2">
                    <Icons.Import className="h-4 w-4" />
                    {t("asset:quoteTable.import_quotes")}
                  </Link>
                </Button>
              </div>
            )}
          </div>
        </div>
        <div className="rounded-md border">
          <Table>
            <TableHeader className="bg-muted">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} colSpan={header.colSpan}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {isAddingQuote && (
                <TableRow>
                  <TableCell>
                    <DatePickerInput
                      value={new Date(newQuote.timestamp || "")}
                      onChange={(date: Date | undefined) =>
                        date && handleInputChange("timestamp", date, true)
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      value={newQuote.open}
                      onChange={(e) => handleInputChange("open", e.target.value, true)}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      value={newQuote.high}
                      onChange={(e) => handleInputChange("high", e.target.value, true)}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      value={newQuote.low}
                      onChange={(e) => handleInputChange("low", e.target.value, true)}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      value={newQuote.close}
                      onChange={(e) => handleInputChange("close", e.target.value, true)}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      value={newQuote.volume}
                      onChange={(e) => handleInputChange("volume", e.target.value, true)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex space-x-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleAddNew}
                        className="h-8 w-8"
                      >
                        <Icons.Check className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setIsAddingQuote(false)}
                        className="h-8 w-8"
                      >
                        <Icons.Close className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-muted-foreground text-sm">
          {t("asset:quoteTable.page_of", {
            page: table.getState().pagination.pageIndex + 1,
            total: table.getPageCount(),
          })}
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            {t("asset:quoteTable.previous")}
          </Button>
          <Select
            value={(table.getState().pagination.pageIndex + 1).toString()}
            onValueChange={(value) => table.setPageIndex(parseInt(value) - 1)}
          >
            <SelectTrigger className="w-[100px]">
              <SelectValue placeholder={t("asset:quoteTable.page_placeholder")} />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: table.getPageCount() }, (_, i) => (
                <SelectItem key={i + 1} value={(i + 1).toString()}>
                  {t("asset:quoteTable.page_number", { number: i + 1 })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            {t("asset:quoteTable.next")}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default QuoteHistoryTable;
