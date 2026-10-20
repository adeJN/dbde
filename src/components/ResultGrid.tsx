import TableProfiles from "./TableProfiles";
import { rawExpression } from "../lib/raw-mode";
import AreaContextMenu, {
  type AreaMenu,
  type AreaMenuItem,
} from "./AreaContextMenu";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import {
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  tableColumnWidths,
} from "../lib/column-widths";
import useColumnResize from "../hooks/useColumnResize";
import {
  editorSearchFromKey,
  editorSearchShortcut,
} from "../lib/editor-search";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type CSSProperties,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowDownUp,
  Search,
  Download,
  Upload,
  Table2,
  CheckCircle2,
  Copy,
  CopyPlus,
  Trash2,
  X,
  Loader2,
  AlertTriangle,
  Filter,
  Plus,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  ChevronLeft,
  Replace,
  Check,
  RotateCcw,
  Layers,
  Columns3,
  LayoutList,
  Rows3,
} from "lucide-react";
import type {
  Driver,
  QueryResult,
  RecordChange,
  StagedChanges,
  TableFilter,
  TableSort,
} from "../types";
import { csvCell, displayValue } from "../lib/sql";
import { rowKeys, rowsAsTsv } from "../lib/rows";
import {
  updateRawCell,
  saveFile,
  columns as loadColumns,
  foreignKeys as loadForeignKeys,
} from "../lib/api";
import ForeignKeyPicker from "./ForeignKeyPicker";
import type { CellPicker } from "./ValuePicker";
import { editorSpec } from "../lib/cell-editors";
import ExportDialog from "./ExportDialog";
import { exportSummaryText } from "../lib/export";
import { validateValue, validateChanges } from "../lib/value-validation";
import type { ColumnInfo, ForeignKeyInfo } from "../types";
import { writeClipboard } from "../lib/clipboard";
import Pagination from "./Pagination";
import TableFilters from "./TableFilters";
import RecordEditor from "./RecordEditor";
import NewRecordRows from "./NewRecordRows";
import {
  buildChanges,
  clearApplied,
  discardRecord,
  editOf,
  isMarkedDeleted,
  recordId,
  toggleDeletes,
  effectiveValue,
  emptyStaged,
  pendingCount,
  setDraftValue,
  stageDraftValues,
  stageValue,
} from "../lib/staged";
import {
  cellRange,
  inRange,
  insertStatements,
  parseClipboardTable,
  tsv,
  updateStatements,
  type CellPosition,
  type CellRange,
} from "../lib/grid";
import CellEditor, { type CellMove } from "./CellEditor";
import ColumnsPopover from "./ColumnsPopover";
import FormView, { type FormField, type FormMove } from "./FormView";
import {
  columnMap,
  GRID_ROW_HEIGHT,
  emptyGridLayout,
  frozenOffsets,
  gridLayoutKey,
  gridViewToggleLabel,
  isGridViewToggle,
  readGridLayout,
  writeGridLayout,
  type GridLayout,
} from "../lib/grid-layout";
const isBinary = (value: unknown) =>
  value !== null && typeof value === "object" && "hex" in value;
// Values an <input> cannot round-trip open in the record dialog instead.
const needsDialog = (value: unknown) =>
  isBinary(value) ||
  (typeof value === "string" && (value.includes("\n") || value.length > 500));
const isCommand = (event: { ctrlKey: boolean; metaKey: boolean }) =>
  event.ctrlKey || event.metaKey;
const NAVIGATION_KEYS = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Tab",
];
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

export default function ResultGrid({
  result,
  busy = false,
  onDelete,
  onPageChange,
  onFilterApply: rawFilterApply,
  onSortChange: rawSortChange,
  onResetView: rawResetView,
  onApplyChanges,
  onLoadRecord,
  onRefresh: rawRefresh,
  staged: stagedProp,
  onStagedChange,
  driver = "sqlite",
  connectionId,
  profileId,
  onImport,
  onProfileApply,
  onDesign,
}: {
  result: QueryResult;
  connectionId?: string;
  /** Connection profile id: hidden and frozen columns are remembered per profile table. */
  profileId?: string;
  busy?: boolean;
  onDelete?: (rows: unknown[][]) => Promise<void>;
  onPageChange?: (page: number, pageSize: number) => void;
  onProfileApply?: (filters: TableFilter[], sort?: TableSort) => void;
  onFilterApply?: (filters: TableFilter[]) => void;
  onSortChange?: (sort?: TableSort) => void;
  onResetView?: () => void;
  /** Writes staged edits, inserts and deletes in one transaction. */
  onApplyChanges?: (changes: RecordChange[]) => Promise<number>;
  onLoadRecord?: (row: unknown[]) => Promise<unknown[]>;
  onRefresh?: () => void;
  onDesign?: () => void;
  /** Staged changes kept by the parent so they survive switching tabs. */
  staged?: StagedChanges;
  onStagedChange?: (staged: StagedChanges) => void;
  /** SQL dialect for Copy As statements. */
  driver?: Driver;
  /** Opens the import wizard for the source table (table views only). */
  onImport?: () => void;
}) {
  const [areaMenu, setAreaMenu] = useState<AreaMenu | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [filter, setFilter] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [findMode, setFindMode] = useState<"find" | "replace">("find");
  const [replacement, setReplacement] = useState("");
  function openFind(mode: "find" | "replace" = "find") {
    // Find highlights grid cells, so it always works in Grid view.
    setView("grid");
    setFindMode(mode);
    setFindOpen(true);
    window.setTimeout(() => {
      findInput.current?.focus();
      findInput.current?.select();
    }, 0);
  }
  const [localPage, setLocalPage] = useState(1);
  const [localPageSize, setLocalPageSize] = useState(1000);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const messageDismiss = useAutoDismiss(message, () => setMessage(""), !error);
  const [confirmRows, setConfirmRows] = useState<unknown[][] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const detailRequest = useRef(0);
  useEffect(
    () => () => {
      detailRequest.current++;
    },
    [],
  );
  const [recordTarget, setRecordTarget] = useState<{
    row: unknown[];
    column: string;
    index: number;
    draftValue?: string;
  } | null>(null);
  const [addingRecord, setAddingRecord] = useState(false);
  const [activeCell, setActiveCell] = useState({ row: 0, column: 0 });
  const focusRequest = useRef<{ row: number; column: number } | null>(null);
  const [editing, setEditing] = useState<{
    row: number;
    column: number;
    initial: string;
    selectAll: boolean;
    /** The cell held NULL when editing began. */
    wasNull?: boolean;
    /** Open the cell's picker right away (Alt+↓). */
    openPicker?: boolean;
  } | null>(null);
  // Where keyboard focus belongs once a write refreshes the result.
  const keepFocus = useRef<{
    row: number | "new";
    draftKey?: string;
    column: number;
    /** False keeps the position and scroll without stealing focus. */
    focus?: boolean;
  } | null>(null);
  const [localStaged, setLocalStaged] = useState<StagedChanges>(emptyStaged);
  const staged = stagedProp ?? localStaged;
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  // Reads the latest staged state, so several updates in one event compose.
  function updateStaged(change: (current: StagedChanges) => StagedChanges) {
    const next = change(stagedRef.current);
    stagedRef.current = next;
    (onStagedChange ?? setLocalStaged)(next);
  }
  const drafts = staged.drafts;
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const focusNewRow = useRef(false);
  const [anchor, setAnchor] = useState<CellPosition | null>(null);
  const dragging = useRef(false);
  const rowAnchor = useRef<string | null>(null);
  const rowDrag = useRef<{
    start: number;
    base: RowSelectionState;
  } | null>(null);
  useEffect(() => {
    const stop = () => {
      dragging.current = false;
      rowDrag.current = null;
    };
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, []);
  const tableIdentity = `${result.source?.database}\u0000${result.source?.table.schema}\u0000${result.source?.table.name}\u0000${result.columns.join("\u0000")}`;
  // Hidden and frozen columns, remembered per profile, database, schema and table.
  const layoutKey = result.source
    ? gridLayoutKey(
        profileId ?? connectionId ?? "",
        result.source.database,
        result.source.table.schema,
        result.source.table.name,
      )
    : null;
  const layoutId = `${layoutKey}\u0000${result.columns.join("\u0000")}`;
  const loadedLayout = useMemo(
    () =>
      layoutKey ? readGridLayout(layoutKey, result.columns) : emptyGridLayout(),
    [layoutId],
  );
  const [layoutState, setLayoutState] = useState({
    id: layoutId,
    layout: loadedLayout,
  });
  const layout =
    layoutState.id === layoutId ? layoutState.layout : loadedLayout;
  /** Displayed columns: visible ones, frozen first. See columnMap for the mapping. */
  const map = useMemo(
    () => columnMap(result.columns, layout),
    [result.columns, layout],
  );
  const lastColumn = map.count - 1;
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsButton = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<"grid" | "form">("grid");
  const [columnInfo, setColumnInfo] = useState<ColumnInfo[]>([]);
  const [tableKeys, setTableKeys] = useState<ForeignKeyInfo[]>([]);
  useEffect(() => {
    let active = true;
    setColumnInfo([]);
    setTableKeys([]);
    if (connectionId && result.source && !result.source.quick) {
      // Foreign keys feed "Select from <table>…"; without them the editors still work.
      const source = result.source;
      void Promise.resolve()
        .then(() =>
          loadForeignKeys(connectionId, source.table, source.database),
        )
        .then((keys) => {
          if (active && Array.isArray(keys)) setTableKeys(keys);
        })
        .catch(() => {});
    }
    if (connectionId && result.source) {
      void loadColumns(
        connectionId,
        result.source.table,
        result.source.database,
      )
        .then((info) => {
          if (active) setColumnInfo(info);
        })
        .catch(() => {
          /* The write API retries metadata and fails closed if unavailable. */
        });
    }
    return () => {
      active = false;
    };
  }, [connectionId, tableIdentity]);
  const validateField = (name: string, value: string | null) => {
    if (value === null && result.source?.primary_keys.includes(name))
      return `${name}: primary key cannot be NULL.`;
    const column = columnInfo.find((item) => item.name === name);
    return column ? validateValue(column, value, driver) : undefined;
  };
  const shownTable = useRef(tableIdentity);
  // Staged work belongs to one table; drop it when the grid shows another.
  useEffect(() => {
    if (shownTable.current === tableIdentity) return;
    shownTable.current = tableIdentity;
    updateStaged(() => emptyStaged());
  }, [tableIdentity]);
  const [context, setContext] = useState<{
    x: number;
    y: number;
    row: unknown[];
    column: string;
    index: number;
    submenu?: "copy" | "filter" | "sort";
  } | null>(null);
  const [confirmedKeys, setConfirmedKeys] = useState<Record<string, unknown>[]>(
    [],
  );
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Staged edits are keyed by primary key, so they stay attached to their records
    // across reloads; nothing has to be dropped when a new result arrives.
    setAnchor(null);
    const keep = keepFocus.current;
    keepFocus.current = null;
    setRowSelection({});
    setLocalPage(1);
    setContext(null);
    detailRequest.current++;
    setRecordTarget(null);
    setAddingRecord(false);
    setEditing(null);
    if (keep) {
      // A save or delete refreshed the page: stay where the keyboard user was.
      const last = canAddInline ? rows.length : rows.length - 1; // Blank entry row.
      const draftIndex = keep.draftKey
        ? stagedRef.current.drafts.findIndex(
            (draft) => draft.key === keep.draftKey,
          )
        : -1;
      const row =
        draftIndex >= 0
          ? rows.length + draftIndex
          : keep.row === "new"
            ? last
            : Math.min(keep.row, last);
      const column = Math.max(0, Math.min(keep.column, lastColumn));
      if (row >= 0 && keep.focus !== false) focusGridCell(row, column);
      else if (row >= 0) setActiveCell({ row, column });
      return;
    }
    setActiveCell({ row: 0, column: 0 });
    focusRequest.current = null;
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [result]);
  useEffect(() => {
    if (!context) return;
    const close = () => setContext(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", close, true);
    };
  }, [context]);
  useEffect(() => {
    if (context)
      document
        .querySelector<HTMLButtonElement>(
          ".grid-context-menu button:not(:disabled)",
        )
        ?.focus();
  }, [context?.row]);
  const data = useMemo(() => {
    const indexed = result.rows.map((values, index) => ({ values, index }));
    const needle = filter.toLowerCase();
    return needle
      ? indexed.filter((row) =>
          row.values.some((v) =>
            displayValue(v).toLowerCase().includes(needle),
          ),
        )
      : indexed;
  }, [result, filter]);
  const columns = useMemo(
    () =>
      result.columns.map((name, index) => ({
        id: String(index),
        header: name,
        accessorFn: (row: { values: unknown[] }) => row.values[index],
      })),
    [result.columns],
  );
  const table = useReactTable({
    data,
    columns,
    getRowId: (row) => String(row.index),
    enableRowSelection: true,
    state: { sorting, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const headers = table.getFlatHeaders();
  const serverPaging = !!result.pagination && !!result.source && !!onPageChange;
  const allRows = table.getRowModel().rows;
  const pageSize = serverPaging ? result.pagination!.page_size : localPageSize;
  const totalRows = serverPaging
    ? result.pagination!.total_rows
    : allRows.length;
  const page = serverPaging
    ? result.pagination!.page
    : Math.min(localPage, Math.max(1, Math.ceil(totalRows / pageSize)));
  const rows = useMemo(
    () =>
      serverPaging
        ? allRows
        : allRows.slice((page - 1) * pageSize, page * pageSize),
    [serverPaging, allRows, page, pageSize],
  );
  function selectRowRange(start: number, end: number, base: RowSelectionState) {
    const next = { ...base };
    for (
      let index = Math.min(start, end);
      index <= Math.max(start, end);
      index++
    ) {
      next[rows[index].id] = true;
    }
    setRowSelection(next);
  }
  function startRowSelection(
    index: number,
    event: ReactMouseEvent<HTMLElement>,
  ) {
    if (locked || event.button !== 0) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    dragging.current = false;
    setAnchor(null);
    const current = rows[index];
    const previous = rows.findIndex((row) => row.id === rowAnchor.current);
    const start = event.shiftKey && previous >= 0 ? previous : index;
    const base = event.metaKey || event.ctrlKey ? { ...rowSelection } : {};
    if (
      (event.metaKey || event.ctrlKey) &&
      rowSelection[current.id] &&
      !event.shiftKey
    ) {
      delete base[current.id];
      setRowSelection(base);
      rowDrag.current = null;
    } else {
      selectRowRange(start, index, base);
      rowDrag.current = { start, base };
    }
    if (!event.shiftKey) rowAnchor.current = current.id;
    focusRowCell(index);
  }
  // Checkboxes and row numbers sit outside the cell grid. After selecting with them,
  // keyboard focus moves into the row so Ctrl/⌘+C, Ctrl/⌘+V, Delete and Ctrl/⌘+Shift+D act
  // on the ticked records right away.
  function focusRowCell(index: number) {
    if (index < 0 || !map.count) return;
    setAnchor(null); // A block left over from an earlier click no longer applies.
    focusGridCell(index, Math.min(activeCell.column, lastColumn));
  }
  // Like Navicat, pending record changes are saved before the page reloads. Inside a
  // transaction they cannot be kept across a reload, so the user decides first.
  async function settleBeforeReload() {
    const current = stagedRef.current;
    if (current.transaction && pendingCount(current, false)) {
      setError(
        "Commit or roll back the transaction before changing the page, sort or filter.",
      );
      return false;
    }
    return (await applyStaged(false)).ok;
  }
  // Runs right away when nothing is pending; otherwise saves first.
  function afterSettling(action: () => void) {
    if (!pendingCount(stagedRef.current, false)) return action();
    void settleBeforeReload().then((ok) => ok && action());
  }
  function guarded<A extends unknown[]>(action?: (...args: A) => void) {
    return action && ((...args: A) => afterSettling(() => action(...args)));
  }
  const onFilterApply = guarded(rawFilterApply);
  const onSortChange = guarded(rawSortChange);
  const onResetView = guarded(rawResetView);
  const onRefresh = guarded(rawRefresh);
  function changePage(nextPage: number, nextSize: number) {
    setRowSelection({});
    setMessage("");
    setError("");
    if (scroll.current) scroll.current.scrollTop = 0;
    if (serverPaging) afterSettling(() => onPageChange!(nextPage, nextSize));
    else {
      setLocalPage(nextPage);
      setLocalPageSize(nextSize);
    }
  }
  const currentRows = useRef(rows);
  currentRows.current = rows;
  const selected = rows
    .filter((row) => row.getIsSelected())
    .map((row) => row.original.values);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => GRID_ROW_HEIGHT,
    overscan: 12,
  });
  const locked = busy || deleting || applying;
  const matches = useMemo(() => {
    const needle = findText.toLowerCase();
    if (!findOpen || !needle) return [];
    // Hidden columns are not searched; matches use displayed column positions.
    return rows.flatMap((row, rowIndex) => {
      const edit = editOf(staged, result, row.original.values);
      return map.order.flatMap((index, column) => {
        const name = result.columns[index];
        const value =
          edit && Object.hasOwn(edit, name)
            ? edit[name]
            : row.original.values[index];
        return displayValue(value).toLowerCase().includes(needle)
          ? [{ row: rowIndex, column }]
          : [];
      });
    });
  }, [findOpen, findText, rows, staged.edits, result, map]);
  const matchIndex = matches.length ? findIndex % matches.length : 0;
  const found = matches[matchIndex];
  const matchedCells = useMemo(
    () => new Set(matches.map((cell) => `${cell.row}:${cell.column}`)),
    [matches],
  );
  function moveFind(direction: number) {
    if (matches.length)
      setFindIndex((matchIndex + direction + matches.length) % matches.length);
  }
  function closeFind() {
    setFindOpen(false);
    focusGridCell(
      found?.row ?? activeCell.row,
      found?.column ?? activeCell.column,
    );
  }
  useEffect(() => {
    if (!found) return;
    virtual.scrollToIndex?.(found.row, { align: "auto" });
    const timer = window.setTimeout(() => {
      scroll.current
        ?.querySelector<HTMLElement>(
          `[data-grid-row="${found.row}"][data-grid-col="${found.column}"]`,
        )
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }, 20);
    return () => window.clearTimeout(timer);
  }, [found?.row, found?.column]);
  const canMutate =
    !!result.source &&
    !result.source.quick &&
    result.source.table.kind === "table";
  const canWrite = canMutate && !!onApplyChanges;
  const canAddInline = canWrite && result.columns.length > 0;
  const lastGridRow = rows.length - 1 + (canAddInline ? drafts.length : 0);
  const canDuplicate = canAddInline;
  const range: CellRange | null =
    anchor &&
    (anchor.row !== activeCell.row || anchor.column !== activeCell.column)
      ? cellRange(anchor, activeCell)
      : null;
  const cellsIn = (area: CellRange) =>
    Array.from({ length: area.bottom - area.top + 1 }, (_, r) =>
      Array.from({ length: area.right - area.left + 1 }, (_, c) => ({
        row: area.top + r,
        column: area.left + c,
      })),
    ).flat();
  function focusGridCell(row: number, column: number) {
    const target = { row, column };
    focusRequest.current = target;
    setActiveCell(target);
    // Draft rows are scrolled into view once their cell takes focus.
    if (!canAddInline || row < rows.length)
      virtual.scrollToIndex?.(row, { align: "auto" });
  }
  useEffect(() => {
    const target = focusRequest.current;
    if (!target) return;
    let attempts = 0;
    const focus = () => {
      if (focusRequest.current !== target) return;
      const cell = scroll.current?.querySelector<HTMLElement>(
        `[data-grid-row="${target.row}"][data-grid-col="${target.column}"]`,
      );
      if (cell) {
        cell.focus({ preventScroll: true });
        // New-record rows sit outside the virtualizer, which scrolls only data rows.
        if (target.row >= rows.length)
          cell.scrollIntoView?.({ block: "nearest" });
        focusRequest.current = null;
      } else if (attempts++ < 4) {
        window.setTimeout(focus, 16);
      }
    };
    focus();
  });
  function navigateGrid(
    event: ReactKeyboardEvent<HTMLElement>,
    row: number,
    column: number,
    key = event.key,
  ) {
    const command = isCommand(event);
    if (event.altKey || (event.metaKey && !NAVIGATION_KEYS.includes(event.key)))
      return false;
    let nextRow = row;
    let nextColumn = column;
    // Navicat: Ctrl+←/→ first/last column; Ctrl+↑/↓ and Ctrl+PgUp/PgDn first/last
    // row of the page (the draft rows count as their own block).
    const lastOnPage = row < rows.length ? rows.length - 1 : lastGridRow;
    const firstOnPage = row < rows.length ? 0 : rows.length;
    switch (key) {
      case "ArrowLeft":
        nextColumn = command ? 0 : Math.max(0, column - 1);
        break;
      case "ArrowRight":
        nextColumn = command ? lastColumn : Math.min(lastColumn, column + 1);
        break;
      case "ArrowUp":
        nextRow = command ? firstOnPage : Math.max(0, row - 1);
        break;
      case "ArrowDown":
        nextRow = command
          ? Math.max(0, lastOnPage)
          : Math.min(lastGridRow, row + 1);
        break;
      case "PageUp":
      case "PageDown": {
        if (command) {
          nextRow =
            event.key === "PageUp" ? firstOnPage : Math.max(0, lastOnPage);
          break;
        }
        const step = Math.max(
          1,
          Math.floor(
            (scroll.current?.clientHeight ?? GRID_ROW_HEIGHT * 10) /
              GRID_ROW_HEIGHT,
          ) - 1,
        );
        nextRow =
          event.key === "PageUp"
            ? Math.max(0, row - step)
            : Math.min(lastGridRow, row + step);
        break;
      }
      case "Home":
        if (event.ctrlKey || event.metaKey) nextRow = 0;
        nextColumn = 0;
        break;
      case "End":
        if (event.ctrlKey || event.metaKey) nextRow = lastGridRow;
        nextColumn = lastColumn;
        break;
      case "Tab":
        if (event.shiftKey) {
          if (row === 0 && column === 0) return false;
          nextRow = column === 0 ? row - 1 : row;
          nextColumn = column === 0 ? lastColumn : column - 1;
        } else {
          if (row === lastGridRow && column === lastColumn) return false;
          nextRow = column === lastColumn ? row + 1 : row;
          nextColumn = column === lastColumn ? 0 : column + 1;
        }
        break;
      default:
        return false;
    }
    event.preventDefault();
    focusGridCell(nextRow, nextColumn);
    return true;
  }
  const primaryKeys = result.source?.primary_keys ?? [];
  const canEditCells = canWrite && primaryKeys.length > 0;
  const replaceable = useMemo(
    () =>
      matches.filter(({ row, column }) => {
        const item = rows[row];
        const index = map.toResult(column);
        const value = effectiveValue(
          staged,
          result,
          item.original.values,
          index,
        );
        return (
          !primaryKeys.includes(result.columns[index]) &&
          value != null &&
          !isBinary(value) &&
          !isMarkedDeleted(staged, result, item.original.values)
        );
      }),
    [matches, rows, staged.edits, staged.deletes, result, map],
  );
  async function replaceMatches(all: boolean) {
    if (!canEditCells || locked || applyingRef.current || !findText) return;
    const targets = all
      ? replaceable
      : replaceable.filter(
          (cell) => cell.row === found?.row && cell.column === found?.column,
        );
    if (!targets.length) return;
    const pattern = new RegExp(
      findText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      all ? "gi" : "i",
    );
    const changes = targets.flatMap(({ row, column: display }) => {
      const values = rows[row].original.values;
      const column = map.toResult(display);
      const value = displayValue(
        effectiveValue(stagedRef.current, result, values, column),
      );
      const next = value.replace(pattern, () => replacement);
      return next === value ? [] : [{ values, column, value: next }];
    });
    if (!changes.length) {
      setMessage("Replacement leaves values unchanged.");
      return;
    }
    for (const change of changes) {
      const name = result.columns[change.column];
      const problem = validateField(name, change.value);
      if (problem) {
        setError(`${name}: ${problem}`);
        return;
      }
    }
    setError("");
    updateStaged((current) =>
      changes.reduce(
        (next, cell) =>
          stageValue(next, result, cell.values, cell.column, cell.value),
        current,
      ),
    );
    setFindIndex(0);
    if (stagedRef.current.transaction) {
      setMessage(`${plural(changes.length, "cell")} replaced. Commit to save.`);
    } else {
      const outcome = await applyStaged(false, { report: false });
      if (!outcome.ok)
        setError(outcome.error ?? "Replacement could not be saved.");
      else setMessage(`${plural(changes.length, "cell")} replaced and saved.`);
    }
  }
  function openDetails(rowIndex: number, column: number, draftValue?: string) {
    const row = rows[rowIndex];
    if (!row) return;
    const request = ++detailRequest.current;
    const open = (values: unknown[]) => {
      if (request !== detailRequest.current) return;
      setMessage("");
      setRecordTarget({
        row: values,
        column: result.columns[map.toResult(column)],
        index: map.toResult(column),
        draftValue,
      });
    };
    if (onLoadRecord) {
      setMessage("Loading full record…");
      void onLoadRecord(row.original.values)
        .then(open)
        .catch((cause) => {
          if (request === detailRequest.current) {
            setMessage("");
            setError(String(cause));
          }
        });
    } else open(row.original.values);
  }
  type PickTarget =
    | { kind: "row"; row: number; column: number }
    | { kind: "draft"; draft: number; column: number }
    | { kind: "form" };
  const [foreignPick, setForeignPick] = useState<{
    key: ForeignKeyInfo;
    target: PickTarget;
    /** The stored row being edited (kind "row"). */
    values?: unknown[];
    current: Record<string, unknown>;
    returnTo: HTMLElement | null;
  } | null>(null);
  /**
   * The special editor of a column (date/time, ENUM, SET, boolean) and, for columns in
   * a foreign key, "Select from <table>…". Existing records retain their stored
   * identity while the chosen values are staged, including primary key fields.
   */
  function pickerFor(name: string, target: PickTarget): CellPicker | undefined {
    const info = columnInfo.find((column) => column.name === name);
    const spec = editorSpec(info, driver);
    const key = tableKeys.find((item) => item.columns.includes(name));
    const keyAllowed = !!key && !!connectionId;
    if (!spec && !keyAllowed) return undefined;
    return {
      spec,
      nullable: info?.nullable ?? true,
      driver,
      foreignKey: keyAllowed
        ? {
            label: `Select from ${key.referenced_table.name}…`,
            onOpen: () => openForeignPick(key, target),
          }
        : undefined,
    };
  }
  function openForeignPick(key: ForeignKeyInfo, target: PickTarget) {
    if (busyNow()) return;
    const returnTo = document.activeElement as HTMLElement | null;
    let values: unknown[] | undefined;
    let current: Record<string, unknown> = {};
    if (target.kind === "row") {
      values = rows[target.row]?.original.values;
      if (!values) return;
      const stored = values;
      current = Object.fromEntries(
        key.columns.map((name) => [
          name,
          effectiveValue(
            stagedRef.current,
            result,
            stored,
            result.columns.indexOf(name),
          ),
        ]),
      );
    } else {
      const draft = target.kind === "draft" ? drafts[target.draft] : formDraft;
      current = draft
        ? { ...draft.values }
        : Object.fromEntries(
            key.columns.map((name) => [
              name,
              effectiveValue(
                stagedRef.current,
                result,
                formValues,
                result.columns.indexOf(name),
              ),
            ]),
          );
    }
    setEditing(null);
    setForeignPick({ key, target, values, current, returnTo });
  }
  function closeForeignPick() {
    const pick = foreignPick;
    setForeignPick(null);
    if (!pick) return;
    const { target } = pick;
    if (target.kind === "row") focusGridCell(target.row, target.column);
    else if (target.kind === "draft")
      focusGridCell(rows.length + target.draft, target.column);
    else window.setTimeout(() => pick.returnTo?.focus(), 0);
  }
  /** Stages every column of the chosen key; nothing is written until record leave. */
  function applyForeignPick(chosen: Record<string, string | null>) {
    const pick = foreignPick;
    if (!pick || busyNow()) return;
    for (const [name, value] of Object.entries(chosen)) {
      const problem = validateField(name, value);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setError("");
    const names = Object.keys(chosen);
    const { target } = pick;
    if (target.kind === "row" && pick.values) {
      const stored = pick.values;
      if (!canEditCells || !recordId(result, stored)) return;
      updateStaged((current) =>
        names.reduce(
          (next, name) =>
            stageValue(
              next,
              result,
              stored,
              result.columns.indexOf(name),
              chosen[name],
            ),
          current,
        ),
      );
    } else if (target.kind === "draft") {
      updateStaged((current) => ({
        ...current,
        drafts: names.reduce(
          (list, name) => setDraftValue(list, target.draft, name, chosen[name]),
          current.drafts,
        ),
      }));
    } else names.forEach((name) => stageFormValue(name, chosen[name]));
    setMessage(
      `${names.join(", ")} set from ${pick.key.referenced_table.name}. Saved when you leave the record.`,
    );
    closeForeignPick();
  }
  function beginCellEdit(
    rowIndex: number,
    column: number,
    text?: string,
    openPicker = false,
  ) {
    const row = rows[rowIndex];
    if (!row || locked) return;
    const index = map.toResult(column);
    const value = effectiveValue(staged, result, row.original.values, index);
    if (!canEditCells) return openDetails(rowIndex, column); // Read-only details.
    if (rawMode && primaryKeys.includes(result.columns[index])) {
      setError("Turn off Raw Mode to edit a primary key value.");
      return;
    }
    if (text === undefined ? needsDialog(value) : text.includes("\n"))
      return openDetails(rowIndex, column, text);
    if (openPicker) {
      const picker = pickerFor(result.columns[index], {
        kind: "row",
        row: rowIndex,
        column,
      });
      if (!picker) return;
      if (!picker.spec) return picker.foreignKey?.onOpen();
    }
    setError("");
    setEditing({
      row: rowIndex,
      column,
      initial: text ?? (value == null ? "" : displayValue(value)),
      selectAll: text === undefined,
      wasNull: text === undefined && value == null,
      openPicker,
    });
  }
  const editingHere = (row: number, column: number) =>
    editing?.row === row && editing.column === column;
  function moveTarget(row: number, column: number, move: CellMove) {
    if (move === "down") return { row: Math.min(lastGridRow, row + 1), column };
    if (move === "up") return { row: Math.max(0, row - 1), column };
    if (move === "right")
      return column < lastColumn
        ? { row, column: column + 1 }
        : { row: Math.min(lastGridRow, row + 1), column: 0 };
    if (move === "left")
      return column > 0
        ? { row, column: column - 1 }
        : { row: Math.max(0, row - 1), column: lastColumn };
    return { row, column };
  }
  // Stages cells; nothing is written yet. Existing rows outside a transaction are saved
  // when the cursor leaves the record (Navicat) or right away when an action changes
  // several records at once, as Navicat does for multi-cell edits and pastes.
  /**
   * True (and tells the user) while a save or a page load is running. Changes made in
   * that window would be lost or raced against the incoming result, so they are refused.
   */
  function busyNow() {
    if (!locked && !applyingRef.current) return false;
    setMessage(
      "Wait for the current save or page load to finish, then try again.",
    );
    return true;
  }
  /** Cells use displayed column positions (see columnMap). */
  function stageCells(
    cells: { row: number; column: number; value: string | null }[],
  ) {
    if (busyNow()) return;
    const touched = new Set<number>();
    let skipped = 0;
    updateStaged((current) => {
      let next = current;
      const draftCells: {
        draft: number;
        column: string;
        value: string | null;
      }[] = [];
      for (const { row, column: display, value } of cells) {
        const column = map.toResult(display);
        if (column < 0) continue;
        if (row >= rows.length) {
          if (canAddInline)
            draftCells.push({
              draft: row - rows.length,
              column: result.columns[column],
              value,
            });
        } else if (
          !canEditCells ||
          !recordId(result, rows[row].original.values)
        ) {
          skipped++;
        } else {
          next = stageValue(
            next,
            result,
            rows[row].original.values,
            column,
            value,
          );
          touched.add(row);
        }
      }
      return draftCells.length ? stageDraftValues(next, draftCells) : next;
    });
    if (skipped)
      setMessage(
        `${plural(skipped, "cell")} left unchanged: read-only records cannot be edited here.`,
      );
    if (touched.size > 1 && !stagedRef.current.transaction)
      void applyStaged(false);
  }
  function commitCellEdit(value: string | null, move: CellMove) {
    if (!editing) return;
    const { row, column, selectAll } = editing;
    if (rawMode) {
      if (
        !connectionId ||
        !result.source ||
        !canEditCells ||
        locked ||
        applyingRef.current
      )
        return;
      if (
        stagedRef.current.transaction ||
        pendingCount(stagedRef.current, true)
      ) {
        setError(
          "Save or discard pending edits and leave transaction mode before using Raw Mode.",
        );
        return;
      }
      try {
        const expression = rawExpression(value ?? "", driver);
        const key = rowKeys(result, [rows[row].original.values])[0];
        const source = result.source;
        applyingRef.current = true;
        setApplying(true);
        setEditing(null);
        void updateRawCell(
          connectionId,
          source,
          key,
          result.columns[map.toResult(column)],
          expression,
        )
          .then(() => {
            setError("");
            setMessage("Raw expression saved.");
            rawRefresh?.();
          })
          .catch((cause) => setError(String(cause)))
          .finally(() => {
            applyingRef.current = false;
            setApplying(false);
          });
      } catch (cause) {
        setError(String(cause));
      }
      return;
    }
    const target = moveTarget(row, column, move);
    const current = rows[row]
      ? effectiveValue(
          stagedRef.current,
          result,
          rows[row].original.values,
          map.toResult(column),
        )
      : undefined;
    setEditing(null);
    // Opening a NULL cell and leaving it empty keeps NULL.
    if (!(value === "" && selectAll && current == null)) {
      const area = range && inRange(range, row, column) ? range : null;
      stageCells(
        (area ? cellsIn(area) : [{ row, column }]).map((cell) => ({
          ...cell,
          value,
        })),
      );
      if (area) setAnchor(null);
    }
    if (move !== "none") focusGridCell(target.row, target.column);
  }
  /**
   * Writes staged edits (and drafts when asked) in one transaction. `extra` adds
   * changes from dialogs. Errors are shown in the grid unless the caller shows them.
   */
  async function applyStaged(
    includeDrafts: boolean,
    { report = true, extra = [] as RecordChange[] } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    let changes: RecordChange[];
    // What is being written; clearApplied later removes exactly this and nothing else.
    const sent = stagedRef.current;
    try {
      changes = [...buildChanges(sent, includeDrafts), ...extra];
      if (columnInfo.length) validateChanges(columnInfo, changes, driver);
    } catch (cause) {
      if (report) setError(String(cause));
      return { ok: false, error: String(cause) };
    }
    if (!changes.length) return { ok: true };
    if (!canWrite)
      return {
        ok: false,
        error: "This table view is read-only. Use Open Table to edit records.",
      };
    if (!onApplyChanges || applyingRef.current)
      return { ok: false, error: "Another save is still running." };
    applyingRef.current = true;
    setApplying(true);
    keepFocus.current = {
      ...activeCell,
      focus: !!scroll.current?.contains(document.activeElement),
    };
    try {
      await onApplyChanges(changes);
      updateStaged((current) => clearApplied(current, sent, includeDrafts));
      setError("");
      setMessage(`${plural(changes.length, "change")} saved.`);
      return { ok: true };
    } catch (cause) {
      keepFocus.current = null;
      if (report) setError(String(cause));
      return { ok: false, error: String(cause) };
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }
  // Track logical draft identity: saving can change row counts and draft positions.
  const activeDraftKey = drafts[activeCell.row - rows.length]?.key;
  const previousRecord = useRef({
    row: activeCell.row,
    draftKey: activeDraftKey,
  });
  useEffect(() => {
    const left = previousRecord.current;
    previousRecord.current = { row: activeCell.row, draftKey: activeDraftKey };
    const same = left.draftKey
      ? left.draftKey === activeDraftKey
      : !activeDraftKey && left.row === activeCell.row;
    if (same || stagedRef.current.transaction || applyingRef.current) return;
    if (left.draftKey) {
      const draft = stagedRef.current.drafts.find(
        (item) => item.key === left.draftKey,
      );
      if (
        !draft ||
        !Object.keys(draft.values).length ||
        !onApplyChanges ||
        !canWrite
      )
        return;
      const destination = {
        row: activeCell.row,
        column: activeCell.column,
        draftKey: activeDraftKey,
      };
      applyingRef.current = true;
      setApplying(true);
      keepFocus.current = {
        ...destination,
        focus: !!scroll.current?.contains(document.activeElement),
      };
      void (async () => {
        try {
          const changes: RecordChange[] = [
            { kind: "insert", values: draft.values },
          ];
          if (columnInfo.length) validateChanges(columnInfo, changes, driver);
          await onApplyChanges(changes);
          updateStaged((current) => ({
            ...current,
            drafts: current.drafts.filter((item) => item.key !== draft.key),
          }));
          setError("");
          setMessage("1 record saved.");
        } catch (cause) {
          keepFocus.current = null;
          setError(String(cause));
          destination.draftKey = draft.key;
        } finally {
          applyingRef.current = false;
          setApplying(false);
          const index = stagedRef.current.drafts.findIndex(
            (item) => item.key === destination.draftKey,
          );
          const row =
            index >= 0
              ? currentRows.current.length + index
              : Math.min(destination.row, currentRows.current.length - 1);
          // Avoid treating save-driven focus restoration as another record exit.
          previousRecord.current = { row, draftKey: destination.draftKey };
          focusGridCell(row, destination.column);
        }
      })();
      return;
    }
    const values = rows[left.row]?.original.values;
    if (values && editOf(stagedRef.current, result, values))
      void applyStaged(false);
  }, [activeCell.row, activeDraftKey]);
  /** Ctrl/⌘+S and the save buttons: everything pending, new records included. */
  async function saveAll() {
    if (!canWrite)
      throw new Error(
        "This table view is read-only. Use Open Table to edit records.",
      );
    if (stagedRef.current.transaction) {
      setMessage("A transaction is open: Commit writes all changes.");
      return;
    }
    focusNewRow.current = true;
    // Visiting or saving the untouched blank row never creates a record.
    const extra: RecordChange[] = [];
    const outcome = await applyStaged(true, { report: false, extra });
    if (!outcome.ok) {
      focusNewRow.current = false;
      throw new Error(outcome.error);
    }
  }
  async function commitTransaction() {
    const outcome = await applyStaged(true);
    if (outcome.ok) {
      updateStaged((current) => ({ ...current, transaction: false }));
      setMessage("Transaction committed.");
    }
  }
  function rollbackTransaction() {
    updateStaged((current) => ({
      ...clearApplied(current, current, true),
      transaction: false,
    }));
    setError("");
    setMessage("Transaction rolled back. Nothing was written.");
  }
  function discardRow(rowIndex: number) {
    const values = rows[rowIndex]?.original.values;
    if (values)
      updateStaged((current) => discardRecord(current, result, values));
    setMessage("Record changes discarded.");
  }
  function discardAll() {
    updateStaged((current) => ({ ...current, edits: {}, deletes: {} }));
    setMessage("Changes discarded.");
  }
  function cancelCellEdit() {
    if (!editing) return;
    const { row, column } = editing;
    setEditing(null);
    focusGridCell(row, column);
  }
  function askDeleteRows(list: unknown[][]) {
    if (busyNow()) return;
    if (deleteReason) {
      setError(deleteReason);
      return;
    }
    if (stagedRef.current.transaction) {
      // Reversible until Commit, so no confirmation; pressing again unmarks.
      updateStaged((current) => toggleDeletes(current, result, list));
      setMessage(
        `${plural(list.length, "row")} marked for deletion. Commit to delete, or press again to unmark.`,
      );
      setRowSelection({});
      return;
    }
    setMessage("");
    try {
      setConfirmedKeys(rowKeys(result, list));
      setConfirmRows(list);
      setError("");
    } catch (cause) {
      setError(String(cause));
    }
  }
  // Copies records into editable drafts above the blank row. Primary keys are left
  // to their defaults so new keys are generated; NULL stays NULL; binary values,
  // which cannot be retyped, also fall back to their defaults.
  function duplicateRows(list: unknown[][], column: number) {
    if (busyNow() || !canDuplicate || !list.length) return;
    if (drafts.length - 1 + list.length > 1000) {
      setError(
        "At most 1,000 new records can be pending. Save or remove some first.",
      );
      return;
    }
    const copies = list.map((values) => ({
      key: crypto.randomUUID(),
      copy: true,
      values: Object.fromEntries(
        result.columns.flatMap((name, i) =>
          primaryKeys.includes(name) || isBinary(values[i])
            ? []
            : [[name, values[i] == null ? null : displayValue(values[i])]],
        ),
      ),
    }));
    const firstCopy = drafts.length - 1;
    updateStaged((current) => ({
      ...current,
      drafts: [
        ...current.drafts.slice(0, -1),
        ...copies,
        current.drafts[current.drafts.length - 1],
      ],
    }));
    setError("");
    setMessage(
      `${plural(copies.length, "record")} copied below. Edit if needed, then press Ctrl/⌘+S or Ctrl/⌘+Enter to save.`,
    );
    setRowSelection({});
    focusGridCell(rows.length + firstCopy, column);
  }
  // After a save the drafts collapse to the blank row; focus it once that renders.
  useEffect(() => {
    if (!focusNewRow.current || drafts.length !== 1) return;
    focusNewRow.current = false;
    focusGridCell(rows.length, 0);
  }, [drafts, result]);
  // Pastes clipboard text. One value fills the selected range (or opens the cell
  // editor); a block fills cells from the top-left and adds rows below as drafts.
  async function pasteIntoCell(rowIndex: number, column: number) {
    if (busyNow()) return;
    try {
      if (!navigator.clipboard?.readText)
        throw new Error("Clipboard reading is unavailable.");
      const text = await navigator.clipboard.readText();
      const parsed = parseClipboardTable(text);
      // Whole records (copied by selecting rows) are added as new records, wherever the
      // cursor is. Overwriting existing cells needs an explicit block selection.
      const wholeRows =
        !range && parsed[parsed.length - 1].length === map.count;
      const left = range ? range.left : wholeRows ? 0 : column;
      // Copies "with headers" (toolbar, Copy As Field Name and Data, spreadsheets) start
      // with the field names; those are not data, so they are not pasted into rows.
      const header =
        parsed.length > 1 &&
        parsed[0].every((name, i) => name === map.names[left + i]);
      const block = header ? parsed.slice(1) : parsed;
      if (wholeRows && canAddInline) return appendRecords(block, header);
      if (block.length === 1 && block[0].length === 1) {
        if (!range) {
          if (rowIndex >= rows.length)
            stageCells([{ row: rowIndex, column, value: block[0][0] }]);
          else beginCellEdit(rowIndex, column, block[0][0]);
          return;
        }
        stageCells(
          cellsIn(range).map((cell) => ({ ...cell, value: block[0][0] })),
        );
        setAnchor(null);
        return;
      }
      const top = range ? range.top : rowIndex;
      stageCells(
        block.flatMap((values, r) =>
          values
            .slice(0, map.count - left)
            .map((value, c) => ({ row: top + r, column: left + c, value })),
        ),
      );
      setAnchor(null);
      const added = Math.max(0, top + block.length - rows.length);
      setMessage(
        `Pasted ${plural(block.length, "row")}${header ? " (header row skipped)" : ""}${added ? `; ${plural(added, "new record")} added below, press Ctrl/⌘+S to save` : ""}.`,
      );
    } catch (cause) {
      setError(String(cause));
    }
  }
  /**
   * Adds pasted whole records as new rows above the blank row. A key that matches a
   * record already loaded is a copy of it, so the key is left empty for the database
   * to generate; pasting it would only fail as a duplicate key.
   */
  function appendRecords(block: string[][], header: boolean) {
    // Pasted records hold the displayed columns; loaded rows hold every column.
    const keyShown = primaryKeys.map((name) => map.names.indexOf(name));
    const keyStored = primaryKeys.map((name) => result.columns.indexOf(name));
    const keyText = (values: unknown[], positions: number[]) =>
      JSON.stringify(
        positions.map((i) =>
          values[i] == null ? "" : displayValue(values[i]),
        ),
      );
    const loaded = new Set(
      keyShown.length && keyShown.every((i) => i >= 0)
        ? rows.map((row) => keyText(row.original.values, keyStored))
        : [],
    );
    let cleared = 0;
    const base = stagedRef.current.drafts.length - 1; // The blank row's position.
    const cells = block.flatMap((values, r) => {
      const copy = loaded.has(keyText(values, keyShown));
      if (copy) cleared++;
      return map.names.flatMap((name, c) =>
        copy && primaryKeys.includes(name)
          ? []
          : [{ draft: base + r, column: name, value: values[c] ?? "" }],
      );
    });
    updateStaged((current) => stageDraftValues(current, cells));
    setAnchor(null);
    setRowSelection({});
    setError("");
    setMessage(
      `${plural(block.length, "record")} pasted below${header ? " (header row skipped)" : ""}${cleared ? `; ${plural(cleared, "copied key")} left empty so new keys are generated` : ""}. Press Ctrl/⌘+S to save.`,
    );
    focusGridCell(rows.length + base, 0);
  }
  /** Rows an action applies to: ticked rows, else rows in the range, else this row. */
  function targetRows(rowIndex: number) {
    if (selected.length) return selected;
    if (range)
      return rows
        .slice(range.top, Math.min(range.bottom, rows.length - 1) + 1)
        .map((row) => row.original.values);
    return rows[rowIndex] ? [rows[rowIndex].original.values] : [];
  }
  /** A stored row's values for the displayed columns, in displayed order. */
  const shownValues = (values: unknown[]) =>
    map.order.map((index) => values[index]);
  function copyRange(area: CellRange) {
    if (result.source?.quick) {
      setError("Use Open Table to copy or export complete data.");
      return;
    }
    const shown = map.order.slice(area.left, area.right + 1);
    const values = rows
      .slice(area.top, Math.min(area.bottom, rows.length - 1) + 1)
      .map((row) =>
        shown.map((index) =>
          effectiveValue(staged, result, row.original.values, index),
        ),
      );
    void writeClipboard(
      tsv(
        shown.map((index) => result.columns[index]),
        values,
        "data",
      ),
    )
      .then(() =>
        setMessage(
          `${plural(values.length, "row")} × ${plural(area.right - area.left + 1, "column")} copied.`,
        ),
      )
      .catch((cause) => setError(String(cause)));
  }
  // Spreadsheet-style commands for a focused data cell. Returns true when handled.
  function cellCommand(
    event: ReactKeyboardEvent<HTMLElement>,
    rowIndex: number,
    column: number,
  ) {
    const row = rows[rowIndex];
    const command = isCommand(event);
    const key = event.key;
    const run = (action: () => void) => {
      event.preventDefault();
      action();
      return true;
    };
    if (
      event.shiftKey &&
      !command &&
      (key === "ArrowDown" || key === "ArrowUp")
    ) {
      const next = key === "ArrowDown" ? rowIndex + 1 : rowIndex - 1;
      return run(() => {
        if (next < 0 || next >= rows.length) return;
        if (!anchor) setAnchor({ row: rowIndex, column });
        row.toggleSelected(true);
        rows[next].toggleSelected(true);
        focusGridCell(next, column);
      });
    }
    // Shift+arrows extend a block of cells; other movement starts a new one.
    if (NAVIGATION_KEYS.includes(key) && key !== "Tab") {
      if (event.shiftKey && !anchor) setAnchor({ row: rowIndex, column });
      if (!event.shiftKey) setAnchor(null);
    }
    // Alt+↓ opens the cell's picker (date/time, list, foreign key), like a dropdown.
    if (event.altKey && key === "ArrowDown" && !command && canEditCells) {
      const name = result.columns[map.toResult(column)];
      if (pickerFor(name, { kind: "row", row: rowIndex, column }))
        return run(() => beginCellEdit(rowIndex, column, undefined, true));
    }
    if (navigateGrid(event, rowIndex, column)) return true;
    if (command && key.toLowerCase() === "s")
      return run(
        () => void saveAll().catch((cause) => setError(String(cause))),
      );
    if (key === "Enter" && event.shiftKey)
      return run(() => openDetails(rowIndex, column));
    if ((key === "Enter" && !command) || key === "F2")
      return run(() => beginCellEdit(rowIndex, column));
    if (command && !event.shiftKey && key.toLowerCase() === "c")
      return run(() => {
        if (range) return copyRange(range);
        if (selected.length) return void copySelectedData();
        const value = effectiveValue(
          staged,
          result,
          row.original.values,
          map.toResult(column),
        );
        void writeClipboard(value == null ? "" : displayValue(value))
          .then(() => setMessage("Cell copied."))
          .catch((cause) => setError(String(cause)));
      });
    if (command && key.toLowerCase() === "v")
      return run(() => void pasteIntoCell(rowIndex, column));
    if (command && key.toLowerCase() === "a")
      return run(() => {
        setAnchor(null);
        setRowSelection(Object.fromEntries(rows.map((r) => [r.id, true])));
      });
    if (command && event.shiftKey && !event.altKey && key.toLowerCase() === "d")
      return run(() => duplicateRows(targetRows(rowIndex), column));
    if (
      canAddInline &&
      (key === "Insert" ||
        (command && ["i", "n", "+", "="].includes(key.toLowerCase())))
    )
      return run(() => focusGridCell(lastGridRow, column));
    if (command && (key === "Delete" || key === "Backspace"))
      return run(() => askDeleteRows(targetRows(rowIndex)));
    if (key === " " && !command) return run(() => row.toggleSelected());
    if (key === "Escape") {
      // Navicat: Esc discards the record's changes; then clears block and selection.
      if (editOf(staged, result, row.original.values))
        return run(() => discardRow(rowIndex));
      if (anchor || selected.length)
        return run(() => {
          setAnchor(null);
          setRowSelection({});
        });
    }
    if ((key === "Backspace" || key === "Delete") && !command)
      return run(() => beginCellEdit(rowIndex, column, ""));
    if (key.length === 1 && !command && !event.altKey)
      return run(() => beginCellEdit(rowIndex, column, key));
    return false;
  }
  const deleteReason = result.source?.quick
    ? "Open Table normally to change records."
    : !result.source
      ? "Open a table from Explorer to delete rows. Custom query results are read-only."
      : !result.source.primary_keys.length
        ? "This table has no primary key. Delete rows using an explicit SQL query."
        : !onDelete && !onApplyChanges
          ? "Row deletion is unavailable."
          : selected.length > 1000
            ? "Select at most 1,000 rows per deletion."
            : "";
  async function copyRows() {
    if (result.source?.quick) {
      setError("Use Open Table to copy or export complete data.");
      return;
    }
    setError("");
    setMessage("");
    try {
      await writeClipboard(rowsAsTsv(map.names, selected.map(shownValues)));
      setMessage(
        `${selected.length} row${selected.length === 1 ? "" : "s"} copied with headers.`,
      );
    } catch (e) {
      setError(String(e));
    }
  }
  /**
   * Ctrl/⌘+C on ticked rows: data only, like Navicat, with staged edits included, so
   * pasting back into the grid never turns the field names into a record.
   */
  async function copySelectedData() {
    if (result.source?.quick) {
      setError("Use Open Table to copy or export complete data.");
      return;
    }
    const shown = selected.map((values) =>
      map.order.map((column) => effectiveValue(staged, result, values, column)),
    );
    try {
      await writeClipboard(tsv(map.names, shown, "data"));
      setError("");
      setMessage(`${plural(shown.length, "row")} copied.`);
    } catch (e) {
      setError(String(e));
    }
  }
  async function copyContext(format: "tsv" | "csv" | "json") {
    if (result.source?.quick) {
      setError("Use Open Table to copy or export complete data.");
      return;
    }
    if (!context) return;
    const row = shownValues(context.row);
    const text =
      format === "tsv"
        ? rowsAsTsv(map.names, [row])
        : format === "csv"
          ? [map.names, row]
              .map((values) => values.map(csvCell).join(","))
              .join("\r\n")
          : JSON.stringify(
              Object.fromEntries(
                map.names.map((column, i) => [column, row[i]]),
              ),
              null,
              2,
            );
    setContext(null);
    try {
      await writeClipboard(text);
      setMessage("Record copied.");
      setError("");
    } catch (cause) {
      setError(String(cause));
    }
  }
  function sortColumn(column: string, direction?: "asc" | "desc") {
    if (!onSortChange || !result.source) return;
    onSortChange(direction ? { column, direction } : undefined);
    setContext(null);
  }
  function askDeleteContext() {
    if (!context) return;
    const list = contextRows();
    setContext(null);
    askDeleteRows(list);
  }
  /** The context menu acts on the block or ticked rows it was opened on. */
  function contextRows() {
    if (!context) return [];
    const at = rows.findIndex((row) => row.original.values === context.row);
    if (range && at >= 0 && inRange(range, at, map.toDisplay(context.index)))
      return targetRows(at);
    return selected.includes(context.row) ? selected : [context.row];
  }
  function contextCells() {
    if (!context) return [];
    const at = rows.findIndex((row) => row.original.values === context.row);
    const column = map.toDisplay(context.index);
    return range && inRange(range, at, column)
      ? cellsIn(range)
      : [{ row: at, column }];
  }
  function setContextCells(value: () => string | null) {
    const cells = contextCells();
    setContext(null);
    stageCells(cells.map((cell) => ({ ...cell, value: value() })));
    setAnchor(null);
  }
  async function copyAs(
    format: "insert" | "update" | "data" | "names" | "both",
  ) {
    if (result.source?.quick) {
      setError("Use Open Table to copy complete data.");
      return;
    }
    if (!context) return;
    const list = contextRows();
    const at = rows.findIndex((row) => row.original.values === context.row);
    const area =
      range && inRange(range, at, map.toDisplay(context.index)) ? range : null;
    // Show what the grid shows (visible columns, staged edits included). UPDATE
    // statements still identify records by the full primary key, even when hidden.
    const keyed =
      format === "update"
        ? [
            ...map.order,
            ...primaryKeys
              .map((name) => result.columns.indexOf(name))
              .filter((index) => index >= 0 && !map.order.includes(index)),
          ]
        : map.order;
    const names = keyed.map((index) => result.columns[index]);
    const shown = list.map((values) =>
      keyed.map((column) => effectiveValue(staged, result, values, column)),
    );
    setContext(null);
    let text: string;
    if (format === "insert" || format === "update") {
      if (!result.source) return;
      text =
        format === "insert"
          ? insertStatements(result.source.table, driver, names, shown)
          : updateStatements(
              result.source.table,
              driver,
              names,
              primaryKeys,
              shown,
            );
    } else {
      const left = area ? area.left : 0;
      const right = area ? area.right : lastColumn;
      text = tsv(
        names.slice(left, right + 1),
        shown.map((values) => values.slice(left, right + 1)),
        format,
      );
    }
    try {
      await writeClipboard(text);
      setMessage(
        format === "names"
          ? "Field names copied."
          : `${plural(list.length, "record")} copied.`,
      );
      setError("");
    } catch (cause) {
      setError(String(cause));
    }
  }
  async function pasteContext() {
    if (!context || !navigator.clipboard?.readText) {
      setError("Clipboard reading is unavailable.");
      return;
    }
    const target = context;
    setContext(null);
    const rowIndex = rows.findIndex(
      (row) => row.original.values === target.row,
    );
    try {
      const value = await navigator.clipboard.readText();
      if (rowIndex >= 0)
        beginCellEdit(rowIndex, map.toDisplay(target.index), value);
      else
        setRecordTarget({
          row: target.row,
          column: target.column,
          index: target.index,
          draftValue: value,
        });
    } catch (cause) {
      setError(String(cause));
    }
  }
  function askDelete() {
    setError("");
    setMessage("");
    askDeleteRows(selected);
  }
  async function confirmDelete() {
    if (!confirmRows || !onDelete || deleting) return;
    setDeleting(true);
    setError("");
    try {
      // Pending edits are saved first; the reload after deleting would drop them.
      const settled = await applyStaged(false, { report: false });
      if (!settled.ok) throw new Error(settled.error);
      const count = confirmRows.length;
      keepFocus.current = activeCell;
      await onDelete(confirmRows);
      setConfirmRows(null);
      setRowSelection({});
      setMessage(`${count} row${count === 1 ? "" : "s"} deleted.`);
    } catch (e) {
      keepFocus.current = null;
      setError(String(e));
    } finally {
      setDeleting(false);
    }
  }
  // The export wizard streams the table from the backend (or writes the selected or
  // fetched rows); without a connection the grid falls back to a CSV of this page.
  function openExport() {
    if (!connectionId) return void exportCsv();
    setError("");
    setExportOpen(true);
  }
  async function exportCsv() {
    if (result.source?.quick) {
      setError("Use Open Table to copy or export complete data.");
      return;
    }
    const csv =
      "\uFEFF" +
      [map.names, ...rows.map((r) => shownValues(r.original.values))]
        .map((r) => r.map(csvCell).join(","))
        .join("\r\n");
    try {
      const saved = await saveFile(
        `${result.source?.table.name ?? "dbde-results"}.csv`,
        "csv",
        csv,
      );
      if (saved) {
        setMessage(`Exported ${rows.length} rows to ${saved}.`);
        setError("");
      }
    } catch (cause) {
      setError(String(cause));
    }
  }
  const automaticWidths = useMemo(
    () => tableColumnWidths(result.columns, result.rows, columnInfo),
    [result.columns, result.rows, columnInfo],
  );
  const resize = useColumnResize(
    `dbde.column-widths:${JSON.stringify([connectionId ?? "", result.source?.database ?? "", result.source?.table.schema ?? "", result.source?.table.name ?? "query", result.columns])}`,
    automaticWidths,
  );
  // Widths stay keyed by result column; the template follows the displayed order.
  const columnWidths = resize.widths;
  const gridWidth =
    82 + map.order.reduce((total, index) => total + columnWidths[index], 0);
  const template = `34px 48px ${map.order.map((index) => `${columnWidths[index]}px`).join(" ")}`;
  const frozenLeft = frozenOffsets(columnWidths, map);
  /** Sticky placement for frozen columns, by displayed position. */
  const frozenCell = (display: number) =>
    display < map.frozenCount
      ? {
          className: ` frozen-cell${display === map.frozenCount - 1 ? " frozen-last" : ""}`,
          style: { left: frozenLeft[display] },
        }
      : { className: "", style: undefined };
  const hiddenCount = result.columns.length - map.count;
  const types: Record<string, string | undefined> = Object.fromEntries(
    columnInfo.map((column) => [column.name, column.data_type]),
  );
  function changeLayout(update: (current: GridLayout) => GridLayout) {
    const next = update(layout);
    const nextMap = columnMap(result.columns, next);
    // Keep the cursor on the same column when it is still shown.
    const kept = nextMap.toDisplay(map.toResult(activeCell.column));
    setLayoutState({ id: layoutId, layout: next });
    if (layoutKey) writeGridLayout(layoutKey, result.columns, next);
    setAnchor(null);
    setEditing(null);
    setActiveCell((current) => ({
      ...current,
      column:
        kept >= 0
          ? kept
          : Math.max(0, Math.min(current.column, nextMap.count - 1)),
    }));
  }
  function hideColumn(name: string) {
    changeLayout((current) => ({
      ...current,
      hidden: current.hidden.includes(name)
        ? current.hidden
        : [...current.hidden, name],
    }));
    setMessage(`Column ${name} hidden. Use Columns to show it again.`);
  }
  function toggleFreeze(name: string) {
    changeLayout((current) => ({
      ...current,
      frozen: current.frozen.includes(name)
        ? current.frozen.filter((item) => item !== name)
        : [...current.frozen, name],
    }));
  }
  const formFocus = useRef<HTMLDivElement>(null);
  const viewFocus = useRef(false);
  function switchView(next: "grid" | "form") {
    if (next === view) return;
    setColumnsOpen(false);
    setEditing(null);
    setAnchor(null);
    setContext(null);
    if (next === "form") setFindOpen(false);
    viewFocus.current = true;
    setView(next);
  }
  useEffect(() => {
    if (!viewFocus.current) return;
    viewFocus.current = false;
    if (view === "grid") {
      const row = Math.min(activeCell.row, lastGridRow);
      if (row >= 0 && map.count)
        focusGridCell(row, Math.min(activeCell.column, lastColumn));
    } else {
      (
        formFocus.current?.querySelector<HTMLElement>(
          ".form-field-control :is(input, textarea)",
        ) ??
        formFocus.current?.querySelector<HTMLElement>(
          ".form-view-nav button:not(:disabled)",
        )
      )?.focus();
    }
  }, [view]);
  // Form view shows the active record: a stored row or a new-record draft.
  const formRow = Math.max(0, Math.min(activeCell.row, lastGridRow));
  const formValues =
    formRow < rows.length ? rows[formRow]?.original.values : undefined;
  const formDraftIndex = canAddInline ? formRow - rows.length : -1;
  const formDraft = formDraftIndex >= 0 ? drafts[formDraftIndex] : undefined;
  const formEdit = formValues ? editOf(staged, result, formValues) : undefined;
  const formModified = formDraft
    ? Object.keys(formDraft.values).length > 0
    : !!formEdit;
  const formDeleted =
    !!formValues && isMarkedDeleted(staged, result, formValues);
  const formFields: FormField[] = map.order.map((index) => {
    const name = result.columns[index];
    if (formDraft) {
      const modified = Object.hasOwn(formDraft.values, name);
      const value = modified ? formDraft.values[name] : undefined;
      return {
        name,
        type: types[name],
        value,
        modified,
        error: modified ? validateField(name, value ?? "") : undefined,
        picker: pickerFor(name, { kind: "form" }),
      };
    }
    const value = effectiveValue(staged, result, formValues, index);
    const modified = !!formEdit && Object.hasOwn(formEdit, name);
    const stored = formValues?.[index];
    return {
      name,
      type: types[name],
      value,
      modified,
      multiline:
        typeof stored === "string" &&
        (stored.includes("\n") || stored.length > 80),
      readOnly: !canEditCells
        ? "This result is read-only."
        : isBinary(value)
          ? "Binary values cannot be edited here."
          : formDeleted
            ? "This record is marked for deletion."
            : formValues && !recordId(result, formValues)
              ? "This record cannot be identified by its primary key."
              : undefined,
      error: modified
        ? validateField(name, (value ?? null) as string | null)
        : undefined,
    };
  });
  // Editable stored fields get their special editor; read-only ones stay plain.
  for (const field of formFields)
    if (!formDraft && !field.readOnly && field.picker === undefined)
      field.picker = pickerFor(field.name, { kind: "form" });
  function moveForm(move: FormMove) {
    if (busyNow() || !rows.length) return;
    const last = rows.length - 1;
    const row =
      move === "first"
        ? 0
        : move === "last"
          ? last
          : move === "previous"
            ? Math.min(formRow - 1, last)
            : Math.min(formRow + 1, last);
    setActiveCell((current) => ({ ...current, row: Math.max(0, row) }));
  }
  function stageFormValue(name: string, value: string | null | undefined) {
    if (busyNow()) return;
    if (formDraft) {
      updateStaged((current) => ({
        ...current,
        drafts: setDraftValue(current.drafts, formDraftIndex, name, value),
      }));
      return;
    }
    if (!formValues || !canEditCells || !recordId(result, formValues)) return;
    const values = formValues;
    updateStaged((current) =>
      stageValue(
        current,
        result,
        values,
        result.columns.indexOf(name),
        value === undefined ? "" : value,
      ),
    );
  }
  function discardForm() {
    if (!formDraft) return discardRow(formRow);
    const position = formDraftIndex;
    updateStaged((current) => ({
      ...current,
      drafts:
        position < current.drafts.length - 1
          ? current.drafts.filter((_, index) => index !== position)
          : [
              ...current.drafts.slice(0, -1),
              { key: current.drafts[position].key, values: {} },
            ],
    }));
    setMessage("New record discarded.");
  }
  return (
    <div
      className={`results${resize.resizing ? " resizing-column" : ""}`}
      style={{ "--grid-row-height": `${GRID_ROW_HEIGHT}px` } as CSSProperties}
      onKeyDownCapture={(event) => {
        if (
          isCommand(event) &&
          event.key.toLowerCase() === "d" &&
          !event.shiftKey &&
          !event.altKey
        ) {
          const target = event.target as HTMLElement;
          if (
            target.closest(
              "input, textarea, select, [contenteditable='true'], [role='dialog'], .modal, [role='menu']",
            )
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (!locked && !applyingRef.current) onDesign?.();
          return;
        }
        if (isGridViewToggle(event)) {
          const target = event.target as HTMLElement;
          if (
            !result.columns.length ||
            editing ||
            target.closest("[role='dialog'], .modal, [role='menu']")
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          switchView(view === "grid" ? "form" : "grid");
          return;
        }
        const action = editorSearchFromKey(event);
        if (!action) return;
        const target = event.target as HTMLElement;
        if (target.closest("[role='dialog'], .modal, [role='menu']")) return;
        if (
          target !== searchInput.current &&
          !target.closest(".grid-find-bar") &&
          target.closest("input, textarea, select, [contenteditable='true']")
        )
          return;
        if (locked) return;
        event.preventDefault();
        event.stopPropagation();
        openFind(action);
      }}
      onContextMenu={(event) => {
        if (event.defaultPrevented) {
          setAreaMenu(null);
          return;
        }
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, select, [role='menu']")) return;
        event.preventDefault();
        event.stopPropagation();
        setContext(null);
        const header = target.closest<HTMLElement>("[role='columnheader']");
        const name = header?.getAttribute("aria-label");
        const items: AreaMenuItem[] = [];
        if (name) {
          items.push({
            label: "Copy Column Name",
            action: () => {
              void writeClipboard(name).catch((error) =>
                setError(String(error)),
              );
            },
          });
          items.push({
            label: "Hide Column",
            action: () => hideColumn(name),
          });
          if (hiddenCount)
            items.push({
              label: "Show All Columns",
              action: () =>
                changeLayout((current) => ({ ...current, hidden: [] })),
            });
          items.push({
            label: layout.frozen.includes(name)
              ? "Unfreeze Column"
              : "Freeze Column",
            action: () => toggleFreeze(name),
          });
          items.push({
            label: "Unfreeze All",
            action: () =>
              changeLayout((current) => ({ ...current, frozen: [] })),
            disabled: !map.frozenCount,
          });
          if (result.source && onSortChange) {
            items.push({
              label: "Sort Ascending",
              action: () => sortColumn(name, "asc"),
              disabled: locked,
            });
            items.push({
              label: "Sort Descending",
              action: () => sortColumn(name, "desc"),
              disabled: locked,
            });
            items.push({
              label: "Remove Sort",
              action: () => sortColumn(name),
              disabled: locked || !result.source.sort,
            });
          }
        } else if (canAddInline) {
          items.push({
            label: "New Record",
            action: () => focusGridCell(lastGridRow, 0),
            disabled: locked,
          });
        }
        if (result.source && onFilterApply)
          items.push({
            label: "Show/Hide Filter & Sort",
            action: () => setFiltersOpen((open) => !open),
            disabled: locked,
          });
        if (onResetView)
          items.push({
            label: "Remove All Filters & Sorts",
            action: onResetView,
            disabled:
              locked ||
              (!result.source?.filters?.length && !result.source?.sort),
          });
        if (onRefresh)
          items.push({ label: "Refresh", action: onRefresh, disabled: locked });
        if (items.length)
          setAreaMenu({
            x: event.clientX,
            y: event.clientY,
            trigger: header ?? scroll.current!,
            label: name ? `${name} column actions` : "Table data actions",
            items,
          });
      }}
    >
      {areaMenu && (
        <AreaContextMenu menu={areaMenu} onClose={() => setAreaMenu(null)} />
      )}
      <div className="result-toolbar">
        {result.source?.quick && (
          <span
            className="grid-keyboard-help"
            title="Read-only; open the table normally to edit or copy full data"
          >
            Quick · double-click for full record
          </span>
        )}
        <span className="result-label">
          <Table2 size={15} /> {result.source?.table.name ?? "Results"}{" "}
          <span className="count">
            {(
              result.pagination?.total_rows ?? result.rows.length
            ).toLocaleString()}
          </span>
        </span>
        <span
          className="selection-count"
          aria-live="polite"
          hidden={!selected.length}
        >
          {selected.length ? `${selected.length} selected` : ""}
        </span>
        <div
          className="toolbar-group row-actions"
          role="group"
          aria-label="Record actions"
        >
          {canWrite && (
            <button
              className="button row-action icon-only"
              aria-label="Add record"
              title="Add a record in a form (Ctrl/⌘+I jumps to the new row instead)"
              disabled={locked}
              onClick={() => setAddingRecord(true)}
            >
              <Plus size={15} />
            </button>
          )}
          {canDuplicate && (
            <button
              className="button row-action icon-only"
              aria-label="Duplicate selected rows"
              title="Copy the selected records below as new records you can edit before saving (Ctrl/⌘+Shift+D)"
              onClick={() => duplicateRows(selected, activeCell.column)}
              disabled={!selected.length || locked}
            >
              <CopyPlus size={15} />
            </button>
          )}
          <button
            className="button row-action icon-only"
            aria-label="Copy selected rows"
            title="Copy selected rows with column headers (tab-separated)"
            onClick={() => void copyRows()}
            disabled={!selected.length || locked}
          >
            <Copy size={15} />
          </button>
          <button
            className="button row-action icon-only danger"
            aria-label="Delete selected rows"
            title={deleteReason || "Delete selected rows from the database"}
            onClick={askDelete}
            disabled={!selected.length || locked || !!deleteReason}
          >
            <Trash2 size={15} />
          </button>
          {canEditCells && (
            <button
              className={`button row-action icon-only${rawMode ? " active" : ""}`}
              aria-label="Raw mode"
              aria-pressed={rawMode}
              title="Raw Mode: type NOW(), CURRENT_TIMESTAMP or a supported function into an existing cell. Saves immediately; unavailable during transactions."
              disabled={locked}
              onClick={() => {
                if (
                  !rawMode &&
                  (stagedRef.current.transaction ||
                    pendingCount(stagedRef.current, true))
                ) {
                  setError(
                    "Save or discard pending edits and leave transaction mode before using Raw Mode.",
                  );
                  return;
                }
                setRawMode(!rawMode);
                setEditing(null);
                setView("grid");
                setMessage(
                  !rawMode
                    ? "Raw Mode: supported functions only, for existing cells. Changes save immediately."
                    : "Literal value mode.",
                );
              }}
            >
              <span aria-hidden="true">ƒx</span>
            </button>
          )}
        </div>
        {canWrite && (
          <div
            className="toolbar-group staged-actions"
            role="group"
            aria-label="Pending changes"
          >
            {staged.transaction && (
              <span
                className="transaction-badge"
                title="Nothing is written until Commit"
              >
                <Layers size={12} /> Transaction
              </span>
            )}
            {pendingCount(staged) > 0 && (
              <span className="pending-count" aria-live="polite">
                {plural(pendingCount(staged), "change")} pending
              </span>
            )}
            {staged.transaction ? (
              <>
                <button
                  className="button row-action"
                  title="Write every pending change in one transaction"
                  disabled={locked}
                  onClick={() => void commitTransaction()}
                >
                  <Check size={14} /> Commit
                </button>
                <button
                  className="button row-action danger"
                  title="Discard every pending change"
                  disabled={locked}
                  onClick={rollbackTransaction}
                >
                  <RotateCcw size={14} /> Rollback
                </button>
              </>
            ) : (
              <>
                {pendingCount(staged, false) > 0 && (
                  <>
                    <button
                      className="button row-action icon-only"
                      aria-label="Apply changes"
                      title="Apply changes (Ctrl/⌘+S)"
                      disabled={locked}
                      onClick={() =>
                        void saveAll().catch((cause) => setError(String(cause)))
                      }
                    >
                      <Check size={15} />
                    </button>
                    <button
                      className="button row-action icon-only danger"
                      aria-label="Discard changes"
                      title="Discard unsaved changes (Esc on a record)"
                      disabled={locked}
                      onClick={discardAll}
                    >
                      <RotateCcw size={15} />
                    </button>
                  </>
                )}
                <button
                  className="button row-action compactable-action"
                  aria-label="Begin Transaction"
                  title="Begin a transaction: edits, new records and deletions are kept until Commit, or dropped with Rollback"
                  disabled={locked}
                  onClick={() => {
                    updateStaged((current) => ({
                      ...current,
                      transaction: true,
                    }));
                    setMessage(
                      "Transaction started. Nothing is written until Commit.",
                    );
                  }}
                >
                  <Layers size={14} />
                  <span className="toolbar-label">Begin Transaction</span>
                </button>
              </>
            )}
          </div>
        )}
        <div className="toolbar-group" role="group" aria-label="Table display">
          {!!result.columns.length && (
            <div className="columns-control">
              <button
                ref={columnsButton}
                className={`button row-action columns-trigger compactable-action${hiddenCount ? " active" : ""}`}
                aria-label="Columns"
                aria-haspopup="dialog"
                aria-expanded={columnsOpen}
                title={
                  hiddenCount
                    ? `Show or hide columns (${hiddenCount} hidden)`
                    : "Show or hide columns"
                }
                onClick={() => setColumnsOpen((open) => !open)}
              >
                <Columns3 size={15} />
                <span className="toolbar-label">Columns</span>
                {hiddenCount > 0 && (
                  <span className="columns-hidden-count">{hiddenCount}</span>
                )}
              </button>
              {columnsOpen && (
                <ColumnsPopover
                  columns={result.columns}
                  hidden={layout.hidden}
                  frozen={layout.frozen}
                  types={types}
                  trigger={columnsButton}
                  onChange={(hidden) =>
                    changeLayout((current) => ({ ...current, hidden }))
                  }
                  onClose={() => setColumnsOpen(false)}
                />
              )}
            </div>
          )}
          {!!result.columns.length && (
            <div className="view-toggle" role="group" aria-label="View">
              <button
                className={`button row-action icon-only${view === "grid" ? " active" : ""}`}
                aria-label="Grid view"
                aria-pressed={view === "grid"}
                title={`Grid view (${gridViewToggleLabel()} toggles)`}
                onClick={() => switchView("grid")}
              >
                <Rows3 size={15} />
              </button>
              <button
                className={`button row-action icon-only${view === "form" ? " active" : ""}`}
                aria-label="Form view"
                aria-pressed={view === "form"}
                title={`Form view: one record at a time (${gridViewToggleLabel()} toggles)`}
                onClick={() => switchView("form")}
              >
                <LayoutList size={15} />
              </button>
            </div>
          )}
          {layoutKey && onProfileApply && result.source && (
            <TableProfiles
              key={layoutKey}
              storageKey={layoutKey}
              columns={result.columns}
              filters={result.source.filters ?? []}
              sort={result.source.sort}
              layout={layout}
              disabled={locked}
              onApply={(profile) =>
                afterSettling(() => {
                  changeLayout(() => profile.layout);
                  onProfileApply(profile.filters, profile.sort);
                })
              }
            />
          )}
        </div>
        <div
          className="toolbar-group toolbar-search"
          role="group"
          aria-label="Filters and search"
        >
          {result.source && onFilterApply && (
            <button
              className={`button row-action icon-only filter-action ${result.source.filters?.length ? "active" : ""}`}
              aria-label="Filters"
              aria-expanded={filtersOpen}
              aria-controls="table-filter-builder"
              title={`Filter table rows${result.source.filters?.length ? ` (${result.source.filters.length} active)` : ""}`}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <Filter size={15} />
            </button>
          )}
          <button
            className="button row-action icon-only"
            data-grid-find-trigger
            aria-label="Find in table"
            title={`Find in table (${editorSearchShortcut("find")})`}
            onClick={() => openFind()}
            disabled={locked}
          >
            <Search size={15} />
          </button>
          <button
            className="button row-action icon-only"
            data-grid-replace-trigger
            aria-label="Find and replace in table"
            title={`Find and replace in table (${editorSearchShortcut("replace")})`}
            onClick={() => openFind("replace")}
            disabled={locked}
          >
            <Replace size={15} />
          </button>
          <label className="search small">
            <Search size={14} />
            <input
              aria-label="Filter results"
              ref={searchInput}
              title={
                serverPaging
                  ? "Filter rows on the current page"
                  : "Filter result rows"
              }
              placeholder={
                serverPaging ? "Filter this page…" : "Filter results…"
              }
              value={filter}
              disabled={locked}
              onChange={(e) => {
                setFilter(e.target.value);
                setLocalPage(1);
                setRowSelection({});
                setMessage("");
                if (scroll.current) scroll.current.scrollTop = 0;
              }}
            />
          </label>
        </div>
        <div
          className="toolbar-group"
          role="group"
          aria-label="Import and export"
        >
          {onImport &&
            result.source &&
            result.source.table.kind === "table" && (
              <button
                className="button subtle compactable-action"
                aria-label="Import…"
                onClick={onImport}
                disabled={busy}
                title="Import rows from a CSV, TSV, JSON or Excel file"
              >
                <Upload size={14} />
                <span className="toolbar-label">Import…</span>
              </button>
            )}
          <button
            className="button subtle compactable-action"
            aria-label="Export…"
            onClick={openExport}
            disabled={!result.columns.length}
            title={
              result.source
                ? "Export the table, the filtered rows or the selected rows"
                : "Export the fetched rows"
            }
          >
            <Download size={14} />
            <span className="toolbar-label">Export…</span>
          </button>
        </div>
      </div>
      {exportOpen && connectionId && (
        <ExportDialog
          request={{
            connectionId,
            database: result.source?.database ?? "",
            driver,
            table: result.source?.table,
            columns: result.columns,
            initialColumns: hiddenCount ? map.names : undefined,
            ...(result.source
              ? {
                  view: {
                    filters: result.source.filters ?? [],
                    sort: result.source.sort,
                  },
                }
              : { fetchedRows: result.rows }),
            selectedRows: selected,
          }}
          onDone={(summary) => {
            setExportOpen(false);
            setError("");
            setMessage(exportSummaryText(summary));
          }}
          onClose={() => setExportOpen(false)}
        />
      )}
      {result.source && onFilterApply && filtersOpen && (
        <TableFilters
          columns={result.columns}
          applied={result.source.filters ?? []}
          busy={locked}
          onApply={onFilterApply}
          onClose={() => setFiltersOpen(false)}
          sort={result.source.sort}
          onSortChange={onSortChange}
        />
      )}
      {(message || (error && !confirmRows)) && (
        <div
          {...messageDismiss}
          className={`row-message ${error ? "error" : "success"}`}
          role={error ? "alert" : "status"}
        >
          {error || message}
          <button
            className="icon-button"
            aria-label="Dismiss row action message"
            onClick={() => {
              setError("");
              setMessage("");
            }}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {!!result.columns.length && (
        <div className="row-action-hint">
          {deleteReason || (
            <>
              Table{" "}
              <strong>
                {result.source!.database ? result.source!.database + "." : ""}
                {result.source!.table.schema &&
                result.source!.table.schema !== result.source!.database
                  ? result.source!.table.schema + "."
                  : ""}
                {result.source!.table.name}
              </strong>{" "}
              · Primary key: {result.source!.primary_keys.join(", ")}
            </>
          )}
          <span id="grid-keyboard-help" className="grid-keyboard-help">
            {" · "}Arrow keys move · Type or Enter to edit · Space selects
          </span>
          <details className="grid-shortcuts">
            <summary>Keyboard shortcuts</summary>
            <dl>
              <dt>Arrows · Tab · PgUp/PgDn</dt>
              <dd>Move between cells</dd>
              <dt>Ctrl/⌘+←/→ · Ctrl/⌘+↑/↓ · Ctrl/⌘+Home/End</dt>
              <dd>First/last column · first/last row of the page · grid</dd>
              <dt>Shift+arrows · Shift+click · drag</dt>
              <dd>Select a block of cells</dd>
              {canEditCells && (
                <>
                  <dt>Type · Enter · F2 · double-click</dt>
                  <dd>
                    Edit the cell (fills the whole block when one is selected)
                  </dd>
                  <dt>Enter · Tab · Shift+Tab · Esc</dt>
                  <dd>Finish and move down, right or left · cancel the edit</dd>
                  <dt>Leave the record · Ctrl/⌘+S</dt>
                  <dd>Save the record&apos;s changes (Navicat: Apply)</dd>
                  <dt>Esc on a changed record</dt>
                  <dd>Discard its changes</dd>
                  <dt>Ctrl/⌘+Shift+Backspace</dt>
                  <dd>While editing: set NULL</dd>
                  <dt>Alt/⌥+↓ · ▾ in the editing cell</dt>
                  <dd>
                    Date/time, ENUM, SET or boolean picker; Select from the
                    referenced table for foreign keys
                  </dd>
                  <dt>Ctrl/⌘+V</dt>
                  <dd>
                    Paste a value or a block; extra rows become new records
                  </dd>
                </>
              )}
              {onDesign && (
                <>
                  <dt>Ctrl/⌘+D</dt>
                  <dd>Open Design Table for the current table</dd>
                </>
              )}
              <dt>Shift+Enter</dt>
              <dd>Open the full record dialog</dd>
              <dt>Ctrl/⌘+C</dt>
              <dd>Copy the block, the selected rows, or the cell</dd>
              <dt>Click row number · drag row numbers · Shift+click</dt>
              <dd>Select one or more records with the mouse</dd>
              <dt>Space · Shift+↑/↓ · Ctrl/⌘+A · Esc</dt>
              <dd>Select rows · extend · all · clear</dd>
              {!deleteReason && (
                <>
                  <dt>Ctrl/⌘+Delete · Ctrl/⌘+Backspace</dt>
                  <dd>
                    Delete the selected rows or this row (marked until Commit in
                    a transaction)
                  </dd>
                </>
              )}
              {canAddInline && (
                <>
                  <dt>⌘+ · Insert · Ctrl/⌘+N · Ctrl/⌘+I</dt>
                  <dd>Go to the new record row</dd>
                  <dt>Ctrl/⌘+Shift+D</dt>
                  <dd>
                    Copy the selected rows (or this row) below as new records
                  </dd>
                  <dt>Ctrl/⌘+Enter (new rows)</dt>
                  <dd>
                    Save pending records; leaving a new record also saves it
                    outside a transaction
                  </dd>
                </>
              )}
              <dt>{gridViewToggleLabel()}</dt>
              <dd>
                Switch to Form view (one record at a time; Page Up/Page Down
                move between records)
              </dd>
              <dt>Column header menu · Columns button</dt>
              <dd>Hide, show or freeze columns</dd>
              <dt>Menu key · Shift+F10 · right-click</dt>
              <dd>
                Set to NULL / Empty String, Generate UUID, Copy As
                Insert/Update/TSV
              </dd>
            </dl>
          </details>
        </div>
      )}
      {result.columns.length && view === "form" ? (
        <div className="form-view-host" ref={formFocus}>
          {lastGridRow < 0 ? (
            <div className="empty-inline">No rows match this result.</div>
          ) : (
            <FormView
              fields={formFields}
              title={
                formDraft
                  ? formDraftIndex === drafts.length - 1
                    ? "New record"
                    : `New record ${formDraftIndex + 1} (unsaved)`
                  : `Record ${formRow + 1} of ${rows.length} on this page${formDeleted ? " · marked for deletion" : ""}`
              }
              isDraft={!!formDraft}
              busy={locked}
              modified={formModified}
              can={{
                first: rows.length > 0 && formRow > 0,
                previous: rows.length > 0 && formRow > 0,
                next: formRow < rows.length - 1,
                last: rows.length > 0 && formRow !== rows.length - 1,
                add: canAddInline,
              }}
              onMove={moveForm}
              onChange={stageFormValue}
              onSave={() =>
                void saveAll().catch((cause) => setError(String(cause)))
              }
              onDiscard={discardForm}
              onAdd={() => {
                if (busyNow()) return;
                setActiveCell((current) => ({ ...current, row: lastGridRow }));
              }}
              onDelete={() =>
                formDraft
                  ? discardForm()
                  : formValues && askDeleteRows([formValues])
              }
              deleteLabel={
                formDraft
                  ? "Remove new record"
                  : staged.transaction
                    ? "Mark record for deletion"
                    : "Delete record"
              }
              deleteDisabled={
                formDraft
                  ? formModified
                    ? undefined
                    : "Nothing to remove: the new record is empty."
                  : deleteReason || undefined
              }
            />
          )}
        </div>
      ) : result.columns.length ? (
        <div
          className={`grid-scroll${map.frozenCount ? " has-frozen" : ""}`}
          ref={scroll}
          role="table"
          aria-label="Query results"
          aria-describedby="grid-keyboard-help"
          aria-rowcount={rows.length + 1 + (canAddInline ? drafts.length : 0)}
        >
          <div
            className={`grid-head${columnInfo.some((column) => result.columns.includes(column.name) && column.data_type) ? " has-column-types" : ""}`}
            role="row"
            style={{
              gridTemplateColumns: template,
              minWidth: gridWidth,
            }}
          >
            <span className="selection-cell">
              <input
                type="checkbox"
                aria-label="Select all rows on this page"
                checked={rows.length > 0 && selected.length === rows.length}
                ref={(element) => {
                  if (element)
                    element.indeterminate =
                      selected.length > 0 && selected.length < rows.length;
                }}
                onChange={(e) => {
                  setRowSelection(
                    e.target.checked
                      ? Object.fromEntries(rows.map((row) => [row.id, true]))
                      : {},
                  );
                  focusRowCell(Math.min(activeCell.row, rows.length - 1));
                }}
                disabled={locked || !rows.length}
              />
            </span>
            <span className="row-number-head">#</span>
            {map.order.map((index, display) => {
              const h = headers[index];
              const name = String(h.column.columnDef.header);
              const dataType = columnInfo.find(
                (column) => column.name === name,
              )?.data_type;
              const frozen = frozenCell(display);
              return (
                <div
                  className={`grid-column-header${frozen.className}`}
                  style={frozen.style}
                  key={h.id}
                >
                  <button
                    className="grid-column-sort"
                    role="columnheader"
                    aria-label={name}
                    title={`${name}${dataType ? ` · ${dataType}` : ""}\n${
                      serverPaging
                        ? "Sort all rows by this column"
                        : "Sort fetched results"
                    }`}
                    key={h.id}
                    onClick={
                      result.source && onSortChange
                        ? () => {
                            const column = String(h.column.columnDef.header);
                            const current = result.source?.sort;
                            sortColumn(
                              column,
                              current?.column !== column
                                ? "asc"
                                : current.direction === "asc"
                                  ? "desc"
                                  : undefined,
                            );
                          }
                        : h.column.getToggleSortingHandler()
                    }
                  >
                    <span className="grid-column-label">
                      <span className="grid-column-name">{name}</span>
                      {dataType && (
                        <span className="grid-column-type" title={dataType}>
                          {dataType}
                        </span>
                      )}
                    </span>
                    {result.source?.sort?.column ===
                    h.column.columnDef.header ? (
                      result.source?.sort?.direction === "asc" ? (
                        <ArrowUp size={12} />
                      ) : (
                        <ArrowDown size={12} />
                      )
                    ) : (
                      <ArrowDownUp size={11} />
                    )}
                  </button>
                  <span
                    className="grid-column-resizer"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${name} column`}
                    tabIndex={0}
                    aria-valuemin={MIN_COLUMN_WIDTH}
                    aria-valuemax={MAX_COLUMN_WIDTH}
                    aria-valuenow={columnWidths[index]}
                    title="Drag to resize · Double-click to fit content"
                    onPointerDown={(event) => resize.begin(event, index)}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      resize.change(index);
                    }}
                    onKeyDown={(event) => {
                      if (
                        [
                          "ArrowLeft",
                          "ArrowRight",
                          "Home",
                          "End",
                          "Enter",
                        ].includes(event.key)
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        resize.change(
                          index,
                          event.key === "Enter"
                            ? undefined
                            : event.key === "Home"
                              ? MIN_COLUMN_WIDTH
                              : event.key === "End"
                                ? MAX_COLUMN_WIDTH
                                : columnWidths[index] +
                                  (event.key === "ArrowLeft" ? -10 : 10),
                        );
                      }
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div
            style={{
              height: virtual.getTotalSize(),
              position: "relative",
              minWidth: gridWidth,
            }}
          >
            {virtual.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <div
                  className={`grid-row ${row.getIsSelected() ? "selected" : ""}${activeCell.row === item.index ? " active-row" : ""}${isMarkedDeleted(staged, result, row.original.values) ? " pending-delete" : ""}`}
                  role="row"
                  aria-rowindex={item.index + 2}
                  aria-selected={row.getIsSelected()}
                  onMouseEnter={(event) => {
                    if (rowDrag.current && event.buttons === 1 && !locked)
                      selectRowRange(
                        rowDrag.current.start,
                        item.index,
                        rowDrag.current.base,
                      );
                  }}
                  key={row.id}
                  style={{
                    gridTemplateColumns: template,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <span
                    className="selection-cell"
                    onMouseDown={(event) => {
                      if ((event.target as HTMLElement).closest("input"))
                        return;
                      startRowSelection(item.index, event);
                    }}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select row ${row.original.index + 1}`}
                      checked={row.getIsSelected()}
                      onChange={(event) => {
                        rowAnchor.current = row.id;
                        row.toggleSelected(event.target.checked);
                        focusRowCell(item.index);
                      }}
                      disabled={locked}
                    />
                  </span>
                  <span
                    className="row-number"
                    aria-label={`Select record ${row.original.index + 1}`}
                    title="Click to select record · drag or Shift-click to select a range"
                    onMouseDown={(event) =>
                      startRowSelection(item.index, event)
                    }
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setContext({
                        x: Math.min(event.clientX, window.innerWidth - 230),
                        y: Math.min(event.clientY, window.innerHeight - 420),
                        row: row.original.values,
                        column: result.columns[map.order[0] ?? 0],
                        index: map.order[0] ?? 0,
                      });
                    }}
                  >
                    {editOf(staged, result, row.original.values) && (
                      <span className="row-edited" aria-label="unsaved changes">
                        ✎
                      </span>
                    )}
                    {(page - 1) * pageSize + item.index + 1}
                  </span>
                  {map.order.map((index, i) => {
                    // `i` is the displayed position; `index` the result column.
                    const stored = row.original.values[index];
                    const edit = editOf(staged, result, row.original.values);
                    const modified =
                      !!edit && Object.hasOwn(edit, result.columns[index]);
                    const value = modified
                      ? edit[result.columns[index]]
                      : stored;
                    const frozen = frozenCell(i);
                    return (
                      <span
                        role="cell"
                        style={frozen.style}
                        tabIndex={
                          activeCell.row === item.index &&
                          activeCell.column === i
                            ? 0
                            : -1
                        }
                        data-grid-row={item.index}
                        data-grid-col={i}
                        key={index}
                        onFocus={() =>
                          setActiveCell({ row: item.index, column: i })
                        }
                        onMouseDown={(event) => {
                          if (event.button !== 0 || editingHere(item.index, i))
                            return;
                          // The grid owns block selection; native text selection
                          // can otherwise spread into the sidebar and toolbar.
                          event.preventDefault();
                          window.getSelection()?.removeAllRanges();
                          if (event.shiftKey) {
                            // Shift+click extends the block from the active cell.
                            setAnchor((current) => current ?? activeCell);
                            event.currentTarget.focus();
                          } else {
                            setAnchor({ row: item.index, column: i });
                            dragging.current = true;
                            event.currentTarget.focus({ preventScroll: true });
                          }
                        }}
                        onMouseEnter={(event) => {
                          if (dragging.current && event.buttons === 1)
                            event.currentTarget.focus({ preventScroll: true });
                        }}
                        onClick={(event) => {
                          if (!editingHere(item.index, i))
                            event.currentTarget.focus();
                        }}
                        onDoubleClick={() => {
                          if (!editingHere(item.index, i))
                            beginCellEdit(item.index, i);
                        }}
                        onKeyDown={(event) => {
                          if (editingHere(item.index, i)) return;
                          if (cellCommand(event, item.index, i)) return;
                          if (
                            event.key === "ContextMenu" ||
                            (event.shiftKey && event.key === "F10")
                          ) {
                            event.preventDefault();
                            const rect =
                              event.currentTarget.getBoundingClientRect();
                            setContext({
                              x: Math.min(rect.left, window.innerWidth - 230),
                              y: Math.min(
                                rect.bottom,
                                window.innerHeight - 420,
                              ),
                              row: row.original.values,
                              column: result.columns[index],
                              index,
                            });
                          }
                        }}
                        onContextMenu={(event) => {
                          if (
                            (event.target as HTMLElement).closest(
                              "input, textarea",
                            )
                          )
                            return;
                          event.preventDefault();
                          setContext({
                            x: Math.min(event.clientX, window.innerWidth - 230),
                            y: Math.min(
                              event.clientY,
                              window.innerHeight - 420,
                            ),
                            row: row.original.values,
                            column: result.columns[index],
                            index,
                          });
                        }}
                        className={`${
                          value == null
                            ? "null"
                            : typeof value === "number"
                              ? "number"
                              : ""
                        }${editingHere(item.index, i) ? " editing" : ""}${
                          activeCell.row === item.index &&
                          activeCell.column === i
                            ? " active"
                            : ""
                        }${modified ? " modified" : ""}${
                          range && inRange(range, item.index, i)
                            ? " in-range"
                            : ""
                        }${matchedCells.has(`${item.index}:${i}`) ? " find-match" : ""}${found?.row === item.index && found?.column === i ? " find-current" : ""}${frozen.className}`}
                        title={displayValue(value)}
                      >
                        {editingHere(item.index, i) && editing ? (
                          <CellEditor
                            column={result.columns[index]}
                            initial={editing.initial}
                            selectAll={editing.selectAll}
                            initialNull={editing.wasNull}
                            openPicker={editing.openPicker}
                            picker={
                              rawMode
                                ? undefined
                                : pickerFor(result.columns[index], {
                                    kind: "row",
                                    row: item.index,
                                    column: i,
                                  })
                            }
                            saving={applying}
                            validate={(value) => {
                              if (rawMode) {
                                try {
                                  rawExpression(value ?? "", driver);
                                  return undefined;
                                } catch (cause) {
                                  return String(cause);
                                }
                              }
                              return validateField(
                                result.columns[index],
                                value,
                              );
                            }}
                            onValidationError={setError}
                            onCommit={(next, move) =>
                              void commitCellEdit(next, move)
                            }
                            onCancel={cancelCellEdit}
                            onExpand={(draft) => {
                              setEditing(null);
                              openDetails(item.index, i, draft);
                            }}
                          />
                        ) : (
                          displayValue(value)
                        )}
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {!rows.length && (
            <div className="empty-inline">No rows match this result.</div>
          )}
          {!map.count && (
            <div className="empty-inline">
              All columns are hidden.{" "}
              <button
                className="button subtle"
                onClick={() =>
                  changeLayout((current) => ({ ...current, hidden: [] }))
                }
              >
                Show all columns
              </button>
            </div>
          )}
          {canAddInline && (
            <NewRecordRows
              columns={map.names}
              frozen={frozenLeft}
              template={template}
              gridWidth={gridWidth}
              validate={validateField}
              pickerFor={(name, draft) =>
                pickerFor(name, {
                  kind: "draft",
                  draft,
                  column: map.names.indexOf(name),
                })
              }
              firstRowIndex={rows.length}
              drafts={drafts}
              onDraftsChange={(next) =>
                updateStaged((current) => ({ ...current, drafts: next }))
              }
              active={
                activeCell.row >= rows.length
                  ? {
                      row: activeCell.row - rows.length,
                      column: activeCell.column,
                    }
                  : null
              }
              busy={locked}
              onFocusCell={(draft, column) =>
                setActiveCell({ row: rows.length + draft, column })
              }
              onCellKeyDown={(event, draft, column) => {
                const row = rows.length + draft;
                const command = isCommand(event);
                if (command && ["+", "="].includes(event.key)) {
                  event.preventDefault();
                  focusGridCell(lastGridRow, column);
                  return true;
                }
                if (command && event.key.toLowerCase() === "s") {
                  event.preventDefault();
                  void saveAll().catch((cause) => setError(String(cause)));
                  return true;
                }
                if (command && event.key.toLowerCase() === "v") {
                  event.preventDefault();
                  void pasteIntoCell(row, column);
                  return true;
                }
                return navigateGrid(
                  event,
                  row,
                  column,
                  event.key === "Enter"
                    ? event.shiftKey
                      ? "ArrowUp"
                      : "ArrowDown"
                    : event.key,
                );
              }}
              onSave={saveAll}
            />
          )}
        </div>
      ) : (
        <div className="empty query-completed">
          <CheckCircle2 size={30} />
          <h3>Query completed</h3>
          <p>{result.affected_rows.toLocaleString()} rows affected.</p>
        </div>
      )}
      {findOpen && (
        <div
          className="grid-find-bar"
          role="search"
          aria-label="Find in table"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeFind();
            }
            if (
              event.key === "Enter" &&
              (event.target as HTMLElement).tagName !== "BUTTON"
            ) {
              event.preventDefault();
              event.stopPropagation();
              moveFind(event.shiftKey ? -1 : 1);
            }
          }}
        >
          <select
            className="grid-find-mode"
            aria-label="Table search mode"
            value={findMode}
            onChange={(event) =>
              setFindMode(event.target.value as "find" | "replace")
            }
          >
            <option value="find">Find</option>
            <option value="replace">Replace</option>
          </select>
          <label className="grid-find-input">
            <Search size={15} />
            <input
              ref={findInput}
              aria-label="Find text in table"
              value={findText}
              placeholder="Find in this page…"
              onChange={(event) => {
                setFindText(event.target.value);
                setFindIndex(0);
              }}
            />
            {findText && (
              <button
                className="icon-button"
                aria-label="Clear table search"
                onClick={() => {
                  setFindText("");
                  setFindIndex(0);
                  findInput.current?.focus();
                }}
              >
                <X size={13} />
              </button>
            )}
          </label>
          <span className="grid-find-count" role="status">
            {matches.length
              ? `${matchIndex + 1} of ${matches.length}`
              : findText
                ? "No matches"
                : "Current page"}
          </span>
          <button
            className="icon-button"
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            disabled={!matches.length}
            onClick={() => moveFind(-1)}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Next match"
            title="Next match (Enter)"
            disabled={!matches.length}
            onClick={() => moveFind(1)}
          >
            <ChevronRight size={16} />
          </button>
          <button className="button subtle" onClick={closeFind}>
            Done
          </button>
          {findMode === "replace" && (
            <div className="grid-replace-row">
              <input
                className="grid-replace-input"
                aria-label="Replace with"
                placeholder="Replace with…"
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
                disabled={locked || !canEditCells}
              />
              <button
                className="button subtle"
                disabled={
                  locked ||
                  !canEditCells ||
                  !replaceable.some(
                    (cell) =>
                      cell.row === found?.row && cell.column === found?.column,
                  )
                }
                onClick={() => void replaceMatches(false)}
              >
                Replace
              </button>
              <button
                className="button subtle"
                title="Replace matching editable cells on this page. Primary keys, NULL, binary and deleted records are skipped."
                disabled={locked || !canEditCells || !replaceable.length}
                onClick={() => void replaceMatches(true)}
              >
                Replace All
              </button>
              {!canEditCells && (
                <span className="grid-replace-note">
                  Open an editable table with a primary key to replace values.
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {!!result.columns.length && (
        <Pagination
          page={page}
          pageSize={pageSize}
          totalRows={totalRows}
          estimated={serverPaging && !!result.pagination?.estimated}
          hasNext={serverPaging ? result.pagination?.has_next : undefined}
          rowCount={serverPaging ? result.rows.length : rows.length}
          busy={locked}
          onChange={changePage}
        />
      )}
      <div className="result-footer">
        <span className={busy ? undefined : "success"}>
          <span className={busy ? "dot amber" : "dot"} />{" "}
          {busy ? "Loading page…" : "Query successful"}
        </span>
        <span>
          {rows.length.toLocaleString()} rows
          {filter ? " matching on this page" : " on this page"} <i>·</i>{" "}
          {result.execution_ms.toFixed(1)} ms
          {result.truncated && " · Result limited to 50,000 rows"}
        </span>
      </div>
      {foreignPick && connectionId && result.source && (
        <ForeignKeyPicker
          connectionId={connectionId}
          database={
            driver === "mysql" && foreignPick.key.referenced_table.schema
              ? foreignPick.key.referenced_table.schema
              : result.source.database
          }
          foreignKey={foreignPick.key}
          sourceSchema={result.source.table.schema}
          current={foreignPick.current}
          onPick={applyForeignPick}
          onClose={closeForeignPick}
        />
      )}
      {(recordTarget || addingRecord) && (
        <RecordEditor
          key={recordTarget ? "edit" : "new"}
          columns={result.columns}
          primaryKeys={result.source?.primary_keys ?? []}
          target={recordTarget ?? undefined}
          canEdit={canEditCells}
          canInsert={canWrite}
          onUpdate={async (row, column, value) => {
            const error = validateField(column, value);
            if (error) throw new Error(error);
            if (applyingRef.current)
              throw new Error("Wait for the current save to finish.");
            updateStaged((current) =>
              stageValue(
                current,
                result,
                row,
                result.columns.indexOf(column),
                value,
              ),
            );
            if (stagedRef.current.transaction) return 1;
            const outcome = await applyStaged(false, { report: false });
            if (!outcome.ok) throw new Error(outcome.error);
            return 1;
          }}
          onInsert={async (values) => {
            if (columnInfo.length)
              validateChanges(columnInfo, [{ kind: "insert", values }], driver);
            if (stagedRef.current.transaction) {
              updateStaged((current) => ({
                ...current,
                drafts: [
                  ...current.drafts.slice(0, -1),
                  { key: crypto.randomUUID(), copy: true, values },
                  current.drafts[current.drafts.length - 1],
                ],
              }));
              return 1;
            }
            const outcome = await applyStaged(false, {
              report: false,
              extra: [{ kind: "insert", values }],
            });
            if (!outcome.ok) throw new Error(outcome.error);
            return 1;
          }}
          onClose={() => {
            setRecordTarget(null);
            setAddingRecord(false);
          }}
        />
      )}
      {context && (
        <div
          className="grid-context-menu"
          role="menu"
          style={{ left: Math.max(8, context.x), top: Math.max(8, context.y) }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            role="menuitem"
            disabled={!!deleteReason || locked}
            onClick={askDeleteContext}
          >
            {staged.transaction ? "Mark for Deletion" : "Delete Record"}
          </button>
          <button
            role="menuitem"
            disabled={!canDuplicate || locked}
            onClick={() => {
              // Act on the whole block or selection the clicked row is part of.
              const list = contextRows();
              setContext(null);
              duplicateRows(list, context.index);
            }}
          >
            {selected.length > 1 && selected.includes(context.row)
              ? `Duplicate ${selected.length} Records Below`
              : "Duplicate Record Below"}
          </button>
          <button role="menuitem" onClick={() => void copyContext("tsv")}>
            Copy
          </button>
          <button
            role="menuitem"
            onClick={() =>
              setContext({
                ...context,
                submenu: context.submenu === "copy" ? undefined : "copy",
              })
            }
          >
            Copy As <ChevronRight size={13} />
          </button>
          {context.submenu === "copy" && (
            <div className="grid-context-submenu">
              <button
                role="menuitem"
                disabled={!result.source}
                onClick={() => void copyAs("insert")}
              >
                Insert Statement
              </button>
              <button
                role="menuitem"
                disabled={!result.source}
                onClick={() => void copyAs("update")}
              >
                Update Statement
              </button>
              <button role="menuitem" onClick={() => void copyAs("data")}>
                Tab Separated Values (Data only)
              </button>
              <button role="menuitem" onClick={() => void copyAs("names")}>
                Tab Separated Values (Field Name only)
              </button>
              <button role="menuitem" onClick={() => void copyAs("both")}>
                Tab Separated Values (Field Name and Data)
              </button>
              <button role="menuitem" onClick={() => void copyContext("csv")}>
                CSV
              </button>
              <button role="menuitem" onClick={() => void copyContext("json")}>
                JSON
              </button>
            </div>
          )}
          <button
            role="menuitem"
            disabled={!canEditCells || locked}
            onClick={() => void pasteContext()}
          >
            Paste
          </button>
          <button
            role="menuitem"
            disabled={!canEditCells || locked}
            onClick={() => setContextCells(() => "")}
          >
            Set to Empty String
          </button>
          <button
            role="menuitem"
            disabled={!canEditCells || locked}
            onClick={() => setContextCells(() => null)}
          >
            Set to NULL
          </button>
          <button
            role="menuitem"
            disabled={!canEditCells || locked}
            onClick={() => setContextCells(() => crypto.randomUUID())}
          >
            Generate UUID
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setContext(null);
              openExport();
            }}
          >
            Save Data As…
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const name = context.column;
              setContext(null);
              hideColumn(name);
            }}
          >
            Hide Column
          </button>
          <div className="context-separator" />
          <button
            role="menuitem"
            disabled={!result.source || !onFilterApply}
            onClick={() => {
              setFiltersOpen((open) => !open);
              setContext(null);
            }}
          >
            Show/Hide Filter &amp; Sort
          </button>
          <button
            role="menuitem"
            disabled={!result.source || !onFilterApply}
            onClick={() =>
              setContext({
                ...context,
                submenu: context.submenu === "filter" ? undefined : "filter",
              })
            }
          >
            Filter <ChevronRight size={13} />
          </button>
          {context.submenu === "filter" && (
            <div className="grid-context-submenu">
              <button
                role="menuitem"
                disabled={(result.source?.filters?.length ?? 0) >= 10 || locked}
                onClick={() => {
                  onFilterApply?.([
                    ...(result.source?.filters ?? []),
                    {
                      column: context.column,
                      operator:
                        context.row[context.index] == null
                          ? "is_null"
                          : "equals",
                      value:
                        context.row[context.index] == null
                          ? ""
                          : String(context.row[context.index]),
                    },
                  ]);
                  setContext(null);
                }}
              >
                Equals this value
              </button>
              <button
                role="menuitem"
                disabled={
                  context.row[context.index] == null ||
                  (result.source?.filters?.length ?? 0) >= 10 ||
                  locked
                }
                onClick={() => {
                  onFilterApply?.([
                    ...(result.source?.filters ?? []),
                    {
                      column: context.column,
                      operator: "contains",
                      value: String(context.row[context.index]),
                    },
                  ]);
                  setContext(null);
                }}
              >
                Contains this value
              </button>
            </div>
          )}
          <button
            role="menuitem"
            disabled={!result.source || !onSortChange}
            onClick={() =>
              setContext({
                ...context,
                submenu: context.submenu === "sort" ? undefined : "sort",
              })
            }
          >
            Sort <ChevronRight size={13} />
          </button>
          {context.submenu === "sort" && (
            <div className="grid-context-submenu">
              <button
                role="menuitem"
                onClick={() => sortColumn(context.column, "asc")}
              >
                Ascending
              </button>
              <button
                role="menuitem"
                onClick={() => sortColumn(context.column, "desc")}
              >
                Descending
              </button>
            </div>
          )}
          <button
            role="menuitem"
            disabled={
              !result.source ||
              !onResetView ||
              (!result.source.filters?.length && !result.source.sort)
            }
            onClick={() => {
              onResetView?.();
              setContext(null);
            }}
          >
            Remove All Filters &amp; Sorts
          </button>
          <div className="context-separator" />
          <button
            role="menuitem"
            disabled={!onRefresh || locked}
            onClick={() => {
              onRefresh?.();
              setContext(null);
            }}
          >
            Refresh
          </button>
        </div>
      )}
      {confirmRows && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleting) setConfirmRows(null);
          }}
        >
          <section
            className="modal delete-dialog"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !deleting) setConfirmRows(null);
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-rows-title"
          >
            <header>
              <div className="modal-icon destructive">
                <AlertTriangle size={23} />
              </div>
              <button
                className="icon-button"
                aria-label="Cancel row deletion"
                disabled={deleting}
                onClick={() => setConfirmRows(null)}
              >
                <X size={18} />
              </button>
            </header>
            <h2 id="delete-rows-title">
              Delete {confirmRows.length} row
              {confirmRows.length === 1 ? "" : "s"}?
            </h2>
            <p>
              This permanently removes the selected rows from{" "}
              <strong>
                {result.source?.database} /{" "}
                {result.source?.table.schema
                  ? result.source.table.schema + "."
                  : ""}
                {result.source?.table.name}
              </strong>
              . Related rows may also be affected by database cascades or
              triggers.
            </p>
            <div className="delete-preview">
              {confirmedKeys.slice(0, 3).map((key, i) => (
                <code key={i}>
                  {Object.entries(key)
                    .map(
                      ([column, value]) => `${column}: ${displayValue(value)}`,
                    )
                    .join(" · ")}
                </code>
              ))}
              {confirmRows.length > 3 && (
                <small>and {confirmRows.length - 3} more selected rows</small>
              )}
            </div>
            {error && (
              <div className="form-message error" role="alert">
                {error}
              </div>
            )}
            <footer>
              <button
                className="button secondary"
                autoFocus
                disabled={deleting}
                onClick={() => setConfirmRows(null)}
              >
                Cancel
              </button>
              <button
                className="button destructive"
                disabled={deleting || busy}
                onClick={() => void confirmDelete()}
              >
                {deleting ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Trash2 size={14} />
                )}{" "}
                {deleting
                  ? "Deleting…"
                  : `Delete ${confirmRows.length} row${confirmRows.length === 1 ? "" : "s"}`}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
