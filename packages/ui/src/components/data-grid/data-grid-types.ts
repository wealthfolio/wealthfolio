import type { Cell, RowData, TableMeta } from "@tanstack/react-table";

export type Direction = "ltr" | "rtl";

export type RowHeightValue = "short" | "medium" | "tall" | "extra-tall";

export interface CellSelectOption {
  label: string;
  value: string;
  icon?: React.FC<React.SVGProps<SVGSVGElement>>;
  count?: number;
}

export interface SymbolSearchResult {
  symbol: string;
  /** Canonical asset symbol used for persistence (e.g., "SHOP" for "SHOP.TO") */
  canonicalSymbol?: string;
  /** Canonical exchange MIC used for persistence */
  canonicalExchangeMic?: string;
  /** Market data provider that returned or resolved this symbol */
  providerId?: string;
  /** Provider-native symbol/code (e.g., Yahoo "BRK-B") */
  providerSymbol?: string;
  shortName?: string;
  longName?: string;
  exchange?: string;
  /** Canonical exchange MIC code (e.g., "XNAS", "XTSE") */
  exchangeMic?: string;
  /** Currency derived from exchange (e.g., "USD", "CAD") */
  currency?: string;
  /** Provenance of currency: "provider" or "exchange_inferred" */
  currencySource?: string;
  /** Instrument type (e.g., "EQUITY", "ETF", "BOND", "OPTION") */
  quoteType?: string;
  score: number;
  dataSource?: string;
  quoteMode?: "MARKET" | "MANUAL";
  /** Asset kind for custom assets (e.g., "SECURITY", "CRYPTO", "OTHER") */
  assetKind?: string;
  /** True when this result maps to an existing persisted asset. */
  isExisting?: boolean;
  /** Persisted asset id when this result maps to an existing asset. */
  existingAssetId?: string;
}

export type CellOpts =
  | {
      variant: "short-text";
    }
  | {
      variant: "long-text";
    }
  | {
      variant: "number";
      min?: number;
      max?: number;
      step?: number;
      valueType?: "number" | "string";
      /** Custom renderer for the value while the cell is not being edited. */
      valueRenderer?: (value: number | string | null, rowData: unknown) => React.ReactNode;
    }
  | {
      variant: "select";
      /** Static options or function to get options dynamically based on row data */
      options: CellSelectOption[] | ((rowData: unknown) => CellSelectOption[]);
      /** Custom renderer for the selected value in display mode */
      valueRenderer?: (
        value: string,
        option?: CellSelectOption,
        rowData?: unknown,
      ) => React.ReactNode;
      /** Whether to allow clearing the selection (adds empty option) */
      allowEmpty?: boolean;
      /** Label for the empty option (default: "None") */
      emptyLabel?: string;
    }
  | {
      variant: "multi-select";
      options: CellSelectOption[];
    }
  | {
      variant: "checkbox";
      /** Function to determine if checkbox is disabled based on row data */
      isDisabled?: (rowData: unknown) => boolean;
    }
  | {
      variant: "date";
    }
  | {
      variant: "date-input";
    }
  | {
      variant: "datetime";
    }
  | {
      variant: "url";
    }
  | {
      variant: "file";
      maxFileSize?: number;
      maxFiles?: number;
      accept?: string;
      multiple?: boolean;
    }
  | {
      variant: "symbol";
      onSearch: (query: string) => Promise<SymbolSearchResult[]>;
      /** Called when a symbol is selected. Receives rowIndex, symbol, and full result */
      onSelect?: (rowIndex: number, symbol: string, result?: SymbolSearchResult) => void;
      /** Called when user wants to create a custom asset. Opens a dialog to collect asset metadata. */
      onCreateCustomAsset?: (rowIndex: number, symbol: string) => void;
      /** Optional display context rendered next to the symbol (e.g., exchange). */
      getDisplayContext?: (rowData: unknown) => string | undefined;
      /** Function to determine if symbol cell is disabled based on row data */
      isDisabled?: (rowData: unknown) => boolean;
      /** Function to determine if symbol can be cleared (set to empty) based on row data */
      isClearable?: (rowData: unknown) => boolean;
    }
  | {
      variant: "currency";
    };

export interface UpdateCell {
  rowIndex: number;
  columnId: string;
  value: unknown;
}

declare module "@tanstack/react-table" {
  // biome-ignore lint/correctness/noUnusedVariables: TData and TValue are used in the ColumnMeta interface
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    label?: string;
    helpText?: string;
    cell?: CellOpts;
  }

  // biome-ignore lint/correctness/noUnusedVariables: TData is used in the TableMeta interface
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData extends RowData> {
    dataGridRef?: React.RefObject<HTMLElement | null>;
    cellMapRef?: React.RefObject<Map<string, HTMLDivElement>>;
    focusedCell?: CellPosition | null;
    editingCell?: CellPosition | null;
    selectionState?: SelectionState;
    searchOpen?: boolean;
    readOnly?: boolean;
    getIsCellSelected?: (rowIndex: number, columnId: string) => boolean;
    getIsSearchMatch?: (rowIndex: number, columnId: string) => boolean;
    getIsActiveSearchMatch?: (rowIndex: number, columnId: string) => boolean;
    /** Returns cell validation state with type and messages */
    getCellState?: (rowIndex: number, columnId: string) => CellValidationState | null;
    rowHeight?: RowHeightValue;
    onRowHeightChange?: (value: RowHeightValue) => void;
    onRowSelect?: (rowIndex: number, checked: boolean, shiftKey: boolean) => void;
    onDataUpdate?: (params: UpdateCell | UpdateCell[]) => void;
    onRowsDelete?: (rowIndices: number[]) => void | Promise<void>;
    onColumnClick?: (columnId: string) => void;
    onCellClick?: (rowIndex: number, columnId: string, event?: React.MouseEvent) => void;
    onCellDoubleClick?: (rowIndex: number, columnId: string) => void;
    onCellMouseDown?: (rowIndex: number, columnId: string, event: React.MouseEvent) => void;
    onCellMouseEnter?: (rowIndex: number, columnId: string, event: React.MouseEvent) => void;
    onCellMouseUp?: () => void;
    onCellContextMenu?: (rowIndex: number, columnId: string, event: React.MouseEvent) => void;
    onCellEditingStart?: (rowIndex: number, columnId: string) => void;
    onCellEditingStop?: (opts?: {
      direction?: NavigationDirection;
      moveToNextRow?: boolean;
    }) => void;
    onCellsCopy?: () => void;
    onCellsCut?: () => void;
    onFilesUpload?: (params: {
      files: File[];
      rowIndex: number;
      columnId: string;
    }) => Promise<FileCellData[]>;
    onFilesDelete?: (params: {
      fileIds: string[];
      rowIndex: number;
      columnId: string;
    }) => void | Promise<void>;
    contextMenu?: ContextMenuState;
    onContextMenuOpenChange?: (open: boolean) => void;
    pasteDialog?: PasteDialogState;
    onPasteDialogOpenChange?: (open: boolean) => void;
    onPasteWithExpansion?: () => void;
    onPasteWithoutExpansion?: () => void;
  }
}

export interface CellPosition {
  rowIndex: number;
  columnId: string;
}

export interface CellRange {
  start: CellPosition;
  end: CellPosition;
}

export interface SelectionState {
  selectedCells: Set<string>;
  selectionRange: CellRange | null;
  isSelecting: boolean;
}

export interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
}

export interface PasteDialogState {
  open: boolean;
  rowsNeeded: number;
  clipboardText: string;
}

export type NavigationDirection =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "ctrl+up"
  | "ctrl+down"
  | "ctrl+home"
  | "ctrl+end"
  | "pageup"
  | "pagedown"
  | "pageleft"
  | "pageright";

export interface SearchState {
  searchMatches: CellPosition[];
  matchIndex: number;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onSearch: (query: string) => void;
  onNavigateToNextMatch: () => void;
  onNavigateToPrevMatch: () => void;
}

export interface CellValidationState {
  type: "error" | "warning" | "success";
  messages: string[];
}

export interface DataGridCellProps<TData> {
  cell: Cell<TData, unknown>;
  tableMeta: TableMeta<TData>;
  rowIndex: number;
  columnId: string;
  rowHeight: RowHeightValue;
  isEditing: boolean;
  isFocused: boolean;
  isSelected: boolean;
  isSearchMatch: boolean;
  isActiveSearchMatch: boolean;
  readOnly: boolean;
  /** Cell validation state for error/warning highlighting */
  cellState?: CellValidationState;
}

export interface FileCellData {
  id: string;
  name: string;
  size: number;
  type: string;
  url?: string;
}

export type TextFilterOperator =
  | "contains"
  | "notContains"
  | "equals"
  | "notEquals"
  | "startsWith"
  | "endsWith"
  | "isEmpty"
  | "isNotEmpty";

export type NumberFilterOperator =
  | "equals"
  | "notEquals"
  | "lessThan"
  | "lessThanOrEqual"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "isBetween"
  | "isEmpty"
  | "isNotEmpty";

export type DateFilterOperator =
  | "equals"
  | "notEquals"
  | "before"
  | "after"
  | "onOrBefore"
  | "onOrAfter"
  | "isBetween"
  | "isEmpty"
  | "isNotEmpty";

export type SelectFilterOperator =
  | "is"
  | "isNot"
  | "isAnyOf"
  | "isNoneOf"
  | "isEmpty"
  | "isNotEmpty";

export type BooleanFilterOperator = "isTrue" | "isFalse";

export type FilterOperator =
  | TextFilterOperator
  | NumberFilterOperator
  | DateFilterOperator
  | SelectFilterOperator
  | BooleanFilterOperator;

export interface FilterValue {
  operator: FilterOperator;
  value?: string | number | string[];
  endValue?: string | number;
}
