import { useCallback, useEffect, useRef, useState } from "react";
import {
  Grid3X3,
  Hand,
  KeyRound,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  Search,
  LayoutGrid,
  SlidersHorizontal,
} from "lucide-react";
import { modelTableKey, type ModelTable } from "../lib/database-model";
import {
  arrangeErd,
  ERD_CARD_WIDTH,
  erdBounds,
  erdCardHeight,
  erdFitZoom,
  erdRelationship,
} from "../lib/erd-layout";
export default function ErdCanvas({
  tables,
  selected,
  onSelect,
  onChange,
  onInspect,
}: {
  tables: ModelTable[];
  selected: number;
  onSelect: (index: number) => void;
  onChange: (tables: ModelTable[]) => void;
  onInspect: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null),
    [zoom, setZoom] = useState(1),
    [grid, setGrid] = useState(true),
    [hand, setHand] = useState(false),
    [search, setSearch] = useState("");
  const [camera, setCamera] = useState({ x: 0, y: 0, width: 800, height: 500 });
  const [panning, setPanning] = useState(false);
  const pan = useRef<{
      x: number;
      y: number;
      left: number;
      top: number;
    } | null>(null),
    drag = useRef<{
      index: number;
      x: number;
      y: number;
      left: number;
      top: number;
    } | null>(null);
  const live = useRef({ tables, zoom, onChange });
  live.current = { tables, zoom, onChange };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const d = drag.current;
      if (d) {
        const state = live.current;
        state.onChange(
          state.tables.map((table, index) =>
            index === d.index
              ? {
                  ...table,
                  x: Math.max(0, d.left + (event.clientX - d.x) / state.zoom),
                  y: Math.max(0, d.top + (event.clientY - d.y) / state.zoom),
                }
              : table,
          ),
        );
      }
      const p = pan.current,
        node = viewport.current;
      if (p && node) {
        node.scrollLeft = p.left + p.x - event.clientX;
        node.scrollTop = p.top + p.y - event.clientY;
        setCamera({
          x: node.scrollLeft,
          y: node.scrollTop,
          width: node.clientWidth,
          height: node.clientHeight,
        });
      }
    };
    const end = () => {
      drag.current = null;
      pan.current = null;
      setPanning(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, []);
  const bounds = erdBounds(tables);
  const syncCamera = useCallback(() => {
    const node = viewport.current;
    if (node)
      setCamera({
        x: node.scrollLeft,
        y: node.scrollTop,
        width: node.clientWidth,
        height: node.clientHeight,
      });
  }, []);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    syncCamera();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(syncCamera)
        : undefined;
    observer?.observe(node);
    window.addEventListener("resize", syncCamera);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", syncCamera);
    };
  }, [syncCamera]);
  function changeZoom(next: number, point?: { x: number; y: number }) {
    const node = viewport.current;
    if (!node) return;
    const value = Math.max(0.2, Math.min(2, Number(next.toFixed(3))));
    const anchor = point ?? {
      x: node.clientWidth / 2,
      y: node.clientHeight / 2,
    };
    const left = ((node.scrollLeft + anchor.x) / zoom) * value - anchor.x,
      top = ((node.scrollTop + anchor.y) / zoom) * value - anchor.y;
    setZoom(value);
    requestAnimationFrame(() => {
      node.scrollLeft = left;
      node.scrollTop = top;
      syncCamera();
    });
  }
  function fit() {
    const node = viewport.current;
    if (!node) return;
    setZoom(
      erdFitZoom(
        { width: node.clientWidth, height: node.clientHeight },
        bounds,
      ),
    );
    node.scrollLeft = 0;
    node.scrollTop = 0;
    requestAnimationFrame(syncCamera);
  }
  const zoomAction = useRef(changeZoom);
  zoomAction.current = changeZoom;
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      zoomAction.current(zoom * Math.exp(-event.deltaY * 0.005), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [zoom]);
  // Fit the first successful reverse/import, keeping subsequent table drags at the current zoom.
  const hasFitted = useRef(false);
  useEffect(() => {
    if (tables.length && !hasFitted.current) {
      hasFitted.current = true;
      fit();
    }
  }, [tables.length]);
  function reveal(index: number) {
    const node = viewport.current,
      table = tables[index];
    if (!node || !table) return;
    onSelect(index);
    node.scrollLeft = Math.max(
      0,
      (table.x + ERD_CARD_WIDTH / 2) * zoom - node.clientWidth / 2,
    );
    node.scrollTop = Math.max(
      0,
      (table.y + erdCardHeight(table) / 2) * zoom - node.clientHeight / 2,
    );
    syncCamera();
  }
  function moveMini(clientX: number, clientY: number, rect: DOMRect) {
    const node = viewport.current;
    if (!node) return;
    node.scrollLeft =
      ((clientX - rect.left) / rect.width) * bounds.width * zoom -
      node.clientWidth / 2;
    node.scrollTop =
      ((clientY - rect.top) / rect.height) * bounds.height * zoom -
      node.clientHeight / 2;
    syncCamera();
  }
  const matches = tables
    .map((table, index) => ({ table, index }))
    .filter(({ table }) =>
      `${table.table.schema}.${table.table.name} ${table.columns.map((c) => c.name).join(" ")}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
    );
  const finish = () => {
    pan.current = null;
    drag.current = null;
    setPanning(false);
  };
  return (
    <div className="erd-editor">
      <div className="erd-toolbar">
        <div className="erd-tool-group">
          <button
            className={`icon-button${!hand ? " active" : ""}`}
            aria-label="Select tables"
            aria-pressed={!hand}
            title="Select and move tables"
            onClick={() => setHand(false)}
          >
            <MousePointer2 size={16} />
          </button>
          <button
            className={`icon-button${hand ? " active" : ""}`}
            aria-label="Pan diagram"
            aria-pressed={hand}
            title="Drag to pan (middle mouse button also pans)"
            onClick={() => setHand(true)}
          >
            <Hand size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Arrange tables"
            title="Arrange tables without overlapping"
            onClick={() => {
              const arranged = arrangeErd(tables);
              onChange(arranged);
              const node = viewport.current;
              if (node) {
                setZoom(
                  erdFitZoom(
                    { width: node.clientWidth, height: node.clientHeight },
                    erdBounds(arranged),
                  ),
                );
                node.scrollLeft = 0;
                node.scrollTop = 0;
                requestAnimationFrame(syncCamera);
              }
            }}
          >
            <LayoutGrid size={16} />
          </button>
          <button
            className={`icon-button${grid ? " active" : ""}`}
            aria-label="Toggle diagram grid"
            aria-pressed={grid}
            title="Show/hide canvas grid"
            onClick={() => setGrid(!grid)}
          >
            <Grid3X3 size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Edit selected model table"
            title="Show field and relationship inspector"
            disabled={!tables[selected]}
            onClick={onInspect}
          >
            <SlidersHorizontal size={16} />
          </button>
        </div>
        <span className="erd-count">
          {tables.length} tables ·{" "}
          {tables.reduce((n, t) => n + t.keys.length, 0)} relationships
        </span>
        <label className="search small erd-search">
          <Search size={14} />
          <input
            aria-label="Search diagram"
            placeholder="Find table or field…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches.length) {
                e.preventDefault();
                reveal(
                  matches[
                    (matches.findIndex((m) => m.index === selected) + 1) %
                      matches.length
                  ].index,
                );
              }
            }}
          />
        </label>
        {search && (
          <span className="erd-search-count" role="status">
            {matches.length} matches
          </span>
        )}
      </div>
      <div className="erd-canvas-shell">
        <div
          ref={viewport}
          className={`erd-viewport${hand ? " hand" : ""}${panning ? " panning" : ""}`}
          tabIndex={0}
          aria-label="ER diagram canvas"
          onScroll={syncCamera}
          onKeyDown={(e) => {
            if ((e.target as HTMLElement).closest("input,select,textarea"))
              return;
            if (e.key === "0" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              fit();
            }
            if (e.key === "Escape") {
              finish();
              setHand(false);
            }
          }}
          onPointerDown={(e) => {
            if (e.button !== 1 && !(hand && e.button === 0)) return;
            e.preventDefault();
            pan.current = {
              x: e.clientX,
              y: e.clientY,
              left: e.currentTarget.scrollLeft,
              top: e.currentTarget.scrollTop,
            };
            setPanning(true);
          }}
          onPointerUp={finish}
          onPointerCancel={finish}
        >
          <div
            className={`erd-stage${grid ? " grid" : ""}`}
            style={{
              width: bounds.width * zoom,
              height: bounds.height * zoom,
              minWidth: "100%",
              minHeight: "100%",
              backgroundSize: `${20 * zoom}px ${20 * zoom}px`,
            }}
          >
            <div
              className="erd-world"
              style={{
                width: bounds.width,
                height: bounds.height,
                transform: `scale(${zoom})`,
              }}
            >
              <svg
                className="erd-links"
                width={bounds.width}
                height={bounds.height}
                aria-label="Foreign key relationships"
              >
                {tables.flatMap((from, i) =>
                  from.keys.flatMap((key, k) => {
                    const to = tables.find(
                      (t) =>
                        modelTableKey(t.table) ===
                        modelTableKey(key.referenced_table),
                    );
                    if (!to) return [];
                    return key.columns.map((column, n) => {
                      const edge = erdRelationship(
                        from,
                        to,
                        column,
                        key.referenced_columns[n],
                      );
                      return (
                        <g key={`${i}:${k}:${n}`}>
                          <title>
                            {from.table.name}.{column} → {to.table.name}.
                            {key.referenced_columns[n]}
                          </title>
                          <path d={edge.path} />
                          <text
                            x={edge.x1 + edge.direction * 9}
                            y={edge.y1 - 7}
                          >
                            N
                          </text>
                          <text
                            x={edge.x2 - edge.direction * 18}
                            y={edge.y2 - 7}
                          >
                            1
                          </text>
                        </g>
                      );
                    });
                  }),
                )}
              </svg>
              {tables.map((table, index) => (
                <section
                  key={modelTableKey(table.table)}
                  className={`erd-table${selected === index ? " selected" : ""}${search && !matches.some((m) => m.index === index) ? " dimmed" : ""}`}
                  style={{
                    left: table.x,
                    top: table.y,
                    width: ERD_CARD_WIDTH,
                    height: erdCardHeight(table),
                  }}
                  onClick={() => onSelect(index)}
                >
                  <button
                    className="erd-table-header"
                    title={
                      table.table.schema
                        ? `${table.table.schema}.${table.table.name}`
                        : table.table.name
                    }
                    aria-label={`Move table ${table.table.name}`}
                    onDoubleClick={() => {
                      onSelect(index);
                      onInspect();
                    }}
                    onKeyDown={(e) => {
                      if (
                        ![
                          "ArrowLeft",
                          "ArrowRight",
                          "ArrowUp",
                          "ArrowDown",
                        ].includes(e.key)
                      )
                        return;
                      e.preventDefault();
                      e.stopPropagation();
                      onSelect(index);
                      const step = e.shiftKey ? 24 : 8;
                      onChange(
                        tables.map((t, i) =>
                          i === index
                            ? {
                                ...t,
                                x: Math.max(
                                  0,
                                  t.x +
                                    (e.key === "ArrowLeft"
                                      ? -step
                                      : e.key === "ArrowRight"
                                        ? step
                                        : 0),
                                ),
                                y: Math.max(
                                  0,
                                  t.y +
                                    (e.key === "ArrowUp"
                                      ? -step
                                      : e.key === "ArrowDown"
                                        ? step
                                        : 0),
                                ),
                              }
                            : t,
                        ),
                      );
                    }}
                    onPointerDown={(e) => {
                      if (hand || e.button !== 0) return;
                      e.stopPropagation();
                      e.preventDefault();
                      onSelect(index);
                      drag.current = {
                        index,
                        x: e.clientX,
                        y: e.clientY,
                        left: table.x,
                        top: table.y,
                      };
                    }}
                    onPointerUp={() => {
                      drag.current = null;
                    }}
                    onPointerCancel={() => {
                      drag.current = null;
                    }}
                  >
                    {table.table.name}
                  </button>
                  {table.columns.map((column, i) => {
                    const primary = table.indexes.some(
                        (key) =>
                          key.primary && key.columns.includes(column.name),
                      ),
                      foreign = table.keys.some((key) =>
                        key.columns.includes(column.name),
                      );
                    return (
                      <div
                        className={`erd-field${primary ? " primary" : ""}${foreign ? " foreign" : ""}`}
                        key={i}
                        title={`${column.name}: ${column.data_type}${primary ? " · Primary key" : ""}${foreign ? " · Foreign key" : ""}`}
                        onDoubleClick={() => {
                          onSelect(index);
                          onInspect();
                        }}
                      >
                        <span className="erd-key">
                          {primary ? (
                            <KeyRound size={15} aria-label="Primary key" />
                          ) : foreign ? (
                            <span title="Foreign key">↗</span>
                          ) : null}
                        </span>
                        <span className="erd-field-name">{column.name}</span>
                        <span className="erd-field-type">
                          : {column.data_type}
                        </span>
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          </div>
          {!tables.length && (
            <div className="erd-empty">
              No tables in this model. Use Reverse database or add a model
              table.
            </div>
          )}
        </div>
        {tables.length > 0 && (
          <div className="erd-minimap">
            <svg
              role="img"
              aria-label="Diagram minimap: click to navigate"
              viewBox={`0 0 ${bounds.width} ${bounds.height}`}
              preserveAspectRatio="none"
              onPointerDown={(e) => {
                e.preventDefault();
                moveMini(
                  e.clientX,
                  e.clientY,
                  e.currentTarget.getBoundingClientRect(),
                );
              }}
              onPointerMove={(e) => {
                if (e.buttons === 1)
                  moveMini(
                    e.clientX,
                    e.clientY,
                    e.currentTarget.getBoundingClientRect(),
                  );
              }}
            >
              {tables.map((t, i) => (
                <rect
                  key={i}
                  x={t.x}
                  y={t.y}
                  width={ERD_CARD_WIDTH}
                  height={erdCardHeight(t)}
                  className={i === selected ? "selected" : ""}
                />
              ))}
              <rect
                className="erd-mini-camera"
                x={camera.x / zoom}
                y={camera.y / zoom}
                width={Math.min(bounds.width, camera.width / zoom)}
                height={Math.min(bounds.height, camera.height / zoom)}
              />
            </svg>
            <div className="erd-zoom-controls">
              <button
                className="icon-button"
                aria-label="Zoom out"
                disabled={zoom <= 0.2}
                onClick={() => changeZoom(zoom - 0.1)}
              >
                <Minus size={13} />
              </button>
              <input
                aria-label="Diagram zoom"
                type="range"
                min={20}
                max={200}
                step={5}
                value={Math.round(zoom * 100)}
                onChange={(e) => changeZoom(Number(e.target.value) / 100)}
              />
              <button
                className="icon-button"
                aria-label="Zoom in"
                disabled={zoom >= 2}
                onClick={() => changeZoom(zoom + 0.1)}
              >
                <Plus size={13} />
              </button>
              <button
                className="button subtle"
                aria-label="Reset diagram zoom"
                onClick={() => changeZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                className="icon-button"
                aria-label="Fit diagram"
                title="Fit diagram to viewport (⌘/Ctrl+0)"
                onClick={fit}
              >
                <Maximize2 size={13} />
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="erd-status">
        <span>
          {hand
            ? "Hand tool · drag canvas to pan"
            : "Drag table headers to move · double-click to edit"}{" "}
          · Ctrl/⌘ + wheel to zoom
        </span>
        <span>{tables[selected]?.table.name ?? "ER Model"}</span>
      </div>
    </div>
  );
}
