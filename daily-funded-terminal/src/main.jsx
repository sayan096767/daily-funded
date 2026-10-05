import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import * as signalR from "@microsoft/signalr";
import {
  Activity,
  AlignHorizontalSpaceAround,
  BarChart3,
  CandlestickChart,
  ChartNoAxesCombined,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDot,
  Clock3,
  Crosshair,
  Eye,
  Magnet,
  Menu,
  MoveVertical,
  MousePointer2,
  Minus,
  MoveUpRight,
  PencilLine,
  PanelBottomClose,
  Plus,
  RotateCcw,
  Ruler,
  Search,
  Settings2,
  Shield,
  Star,
  TrendingUp,
  Trash2,
  GitFork,
  X,
} from "lucide-react";
import { CandlestickSeries, ColorType, createChart, TickMarkType } from "lightweight-charts";
import {
  createCandleHistoryPager,
  candleFromLiveTick,
  fitInitialHistoryOnce,
  mergeHistoryWithLive,
  setSeriesDataPreservingVisibleRange,
  shouldLoadOlderHistory,
} from "./candleHistory.js";
import { applyPositionEvent } from "./tradingPositionEvents.js";
import "../node_modules/flag-icons/css/flag-icons.min.css";
import "./styles.css";

const API_BASE = import.meta.env.DEV ? "" : "https://throbbing-bonus-6fed.dailyfunded.workers.dev";
const QUOTE_FALLBACK_MS = 5000;
const LIVE_TICK_MAX_AGE_MS = 5 * 60 * 1000;
const TRADING_API_BASE = import.meta.env.DEV ? "/api" : "https://daily-funded-api.onrender.com/api";
const TRADING_EVENTS_URL = "wss://throbbing-bonus-6fed.dailyfunded.workers.dev/trading/events";
const TRADING_POLL_MS = 5000;
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyArsv-HojE9hn_3BAcJVFh5zp4XS9Dw480",
  authDomain: "daily-funded.firebaseapp.com",
  projectId: "daily-funded",
  storageBucket: "daily-funded.firebasestorage.app",
  messagingSenderId: "1080360028653",
  appId: "1:1080360028653:web:9afa42197ba011c1613fe4",
  measurementId: "G-Y7SP58FQ6H",
};
const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];
const INTERVAL_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const DRAWING_TOOL_GROUPS = [
  {
    id: "lines",
    label: "Lines",
    icon: PencilLine,
    tools: [
      { id: "trend-line", label: "Trend Line", icon: TrendingUp, shortcut: "Alt+T", points: 2 },
      { id: "ray", label: "Ray", icon: TrendingUp, points: 2 },
      { id: "info-line", label: "Info Line", icon: Ruler, points: 2 },
      { id: "extended-line", label: "Extended Line", icon: ChartNoAxesCombined, points: 2 },
      { id: "trend-angle", label: "Trend Angle", icon: MoveUpRight, points: 2 },
      { id: "horizontal-line", label: "Horizontal Line", icon: Minus, shortcut: "Alt+H", points: 1 },
      { id: "horizontal-ray", label: "Horizontal Ray", icon: AlignHorizontalSpaceAround, shortcut: "Alt+J", points: 1 },
      { id: "vertical-line", label: "Vertical Line", icon: MoveVertical, shortcut: "Alt+V", points: 1 },
      { id: "cross-line", label: "Cross Line", icon: Crosshair, shortcut: "Alt+C", points: 1 },
    ],
  },
  {
    id: "fibonacci",
    label: "Fibonacci",
    icon: AlignHorizontalSpaceAround,
    tools: [
      { id: "fib-retracement", label: "Fib Retracement", icon: AlignHorizontalSpaceAround, shortcut: "Alt+F", points: 2 },
    ],
  },
  {
    id: "shapes",
    label: "Shapes",
    icon: CandlestickChart,
    tools: [
      { id: "rectangle", label: "Rectangle", icon: CandlestickChart, shortcut: "Alt+Shift+R", points: 2 },
    ],
  },
  {
    id: "channels",
    label: "Channels",
    icon: Ruler,
    tools: [
      { id: "parallel-channel", label: "Parallel Channel", icon: AlignHorizontalSpaceAround, points: 3 },
      { id: "regression-trend", label: "Regression Trend", icon: TrendingUp, points: 2 },
      { id: "flat-top-bottom", label: "Flat Top/Bottom", icon: Minus, points: 3 },
      { id: "disjoint-channel", label: "Disjoint Channel", icon: ChartNoAxesCombined, points: 3 },
    ],
  },
  {
    id: "pitchforks",
    label: "Pitchforks",
    icon: GitFork,
    tools: [
      { id: "pitchfork", label: "Pitchfork", icon: GitFork, points: 3 },
      { id: "schiff-pitchfork", label: "Schiff Pitchfork", icon: GitFork, points: 3 },
      { id: "modified-schiff-pitchfork", label: "Modified Schiff Pitchfork", icon: GitFork, points: 3 },
      { id: "inside-pitchfork", label: "Inside Pitchfork", icon: GitFork, points: 3 },
    ],
  },
];
const DRAWING_TOOL_BY_ID = new Map(
  DRAWING_TOOL_GROUPS.flatMap((group) =>
    group.tools.map((tool) => [tool.id, { ...tool, group: group.id }])
  )
);
const DRAWING_SHORTCUTS = new Map(
  DRAWING_TOOL_GROUPS.flatMap((group) =>
    group.tools.filter((tool) => tool.shortcut).map((tool) => [
      tool.shortcut.toLowerCase().replaceAll("+", ""),
      tool.id,
    ])
  )
);
const DRAWINGS_STORAGE_KEY = "df-terminal-drawings-v1";

function readStoredDrawings() {
  try {
    const stored = JSON.parse(localStorage.getItem(DRAWINGS_STORAGE_KEY) || "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).map(([symbol, drawings]) => [
      symbol,
      Array.isArray(drawings)
        ? drawings.filter((drawing) =>
          drawing &&
          typeof drawing.id === "string" &&
          DRAWING_TOOL_BY_ID.has(drawing.type) &&
          Array.isArray(drawing.points) &&
          drawing.points.length === DRAWING_TOOL_BY_ID.get(drawing.type).points &&
          drawing.points.every((point) =>
            point &&
            Number.isFinite(point.price) &&
            (Number.isFinite(point.time) ||
              (point.time && typeof point.time === "object" && Number.isInteger(point.time.year)))
          )
        ).map((drawing) => ({
          ...drawing,
          color: typeof drawing.color === "string" && drawing.color ? drawing.color : "#c8eb7b",
          opacity: Number.isFinite(Number(drawing.opacity)) ? Math.min(1, Math.max(0.1, Number(drawing.opacity))) : 1,
          width: [1, 2, 3, 4, 5].includes(Number(drawing.width)) ? Number(drawing.width) : 2,
          lineStyle: ["solid", "dashed", "dotted"].includes(drawing.lineStyle) ? drawing.lineStyle : "solid",
          hidden: Boolean(drawing.hidden),
          locked: Boolean(drawing.locked),
        }))
        : [],
    ]));
  } catch (error) {
    console.warn("Unable to load saved chart drawings.", error);
    return {};
  }
}

function getDrawingLineDash(lineStyle) {
  switch (lineStyle) {
    case "dashed": return "10 7";
    case "dotted": return "2 6";
    default: return undefined;
  }
}

const DRAWING_TOOLBAR_ITEMS = [
  { id: "cursor", label: "Cursor", icon: Crosshair, kind: "menu" },
  { id: "lines", label: "Lines", icon: PencilLine, kind: "menu" },
  { id: "fibonacci", label: "Fibonacci", icon: AlignHorizontalSpaceAround, kind: "menu" },
  { id: "patterns", label: "Patterns", icon: GitFork, kind: "unavailable" },
  { id: "projection", label: "Projection", icon: ChartNoAxesCombined, kind: "unavailable" },
  { id: "brushes", label: "Brushes", icon: MoveUpRight, kind: "menu" },
  { id: "text", label: "Text and notes", icon: Minus, kind: "unavailable" },
  { id: "icons", label: "Icons", icon: Star, kind: "unavailable" },
  { id: "measure", label: "Measure", icon: Ruler, kind: "action" },
  { id: "zoom", label: "Zoom in", icon: Plus, kind: "action" },
  { id: "magnet", label: "Magnet", icon: Magnet, kind: "menu" },
  { id: "lock", label: "Lock drawings", icon: Shield, kind: "action" },
  { id: "visibility", label: "Visibility", icon: Eye, kind: "menu" },
  { id: "remove", label: "Remove drawings", icon: Trash2, kind: "menu" },
];

function DrawingToolbar({
  selectedTool,
  onSelectTool,
  cursorMode,
  onSetCursorMode,
  onToggleLock,
  onRemoveLatestDrawing,
  onClearDrawings,
  drawingCount,
  lockedDrawingCount,
  alwaysRemoveLocked,
  onToggleAlwaysRemoveLocked,
  magnetMode,
  onSetMagnetMode,
  drawingsVisible,
  onToggleVisibility,
  positionsVisible,
  onTogglePositionsVisibility,
  onHideAll,
  hiddenDrawings,
  onShowDrawing,
  onZoomIn,
}) {
  const [openMenu, setOpenMenu] = useState("");
  const toolbarRef = useRef(null);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (!toolbarRef.current?.contains(event.target)) setOpenMenu("");
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setOpenMenu("");
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (selectedTool) setOpenMenu("");
  }, [selectedTool]);

  function selectTool(toolId) {
    onSelectTool(toolId);
    setOpenMenu("");
  }

  return (
    <div className="drawing-toolbar" ref={toolbarRef} aria-label="Chart drawing tools">
      {DRAWING_TOOLBAR_ITEMS.map((item, index) => {
        const Icon = item.icon;
        const isOpen = openMenu === item.id;
        const unavailable = item.kind === "unavailable";
        const buttonLabel = item.id === "lock" && drawingCount > 0 && lockedDrawingCount === drawingCount
          ? "Unlock drawings"
          : item.label;
        const pressed = item.id === "cursor"
          ? cursorMode === "cross"
          : item.id === "lines" || item.id === "fibonacci" || item.id === "brushes"
            ? Boolean(
              selectedTool &&
              (item.id === "brushes"
                ? DRAWING_TOOL_BY_ID.get(selectedTool)?.group === "shapes"
                : item.id === "fibonacci"
                ? DRAWING_TOOL_BY_ID.get(selectedTool)?.group === "fibonacci"
                : ["lines", "channels", "pitchforks"].includes(DRAWING_TOOL_BY_ID.get(selectedTool)?.group))
            )
            : item.id === "magnet"
              ? magnetMode !== "off"
              : item.id === "lock"
                ? drawingCount > 0 && lockedDrawingCount === drawingCount
                : false;
        return (
          <React.Fragment key={item.id}>
            {index === 8 || index === 10 || index === 12
              ? <span className="drawing-toolbar-divider" aria-hidden="true" />
              : null}
            <div className="drawing-toolbar-item">
              <button
                type="button"
                className={`drawing-toolbar-button ${pressed ? "drawing-toolbar-button-active" : ""}`}
                aria-label={buttonLabel}
                aria-pressed={item.kind === "action" || item.id === "cursor" ? pressed : undefined}
                aria-expanded={item.kind === "menu" ? isOpen : undefined}
                title={unavailable ? `${item.label}: not implemented yet` : buttonLabel}
                disabled={unavailable || (item.id === "lock" && !drawingCount)}
                onClick={() => {
                  if (unavailable) return;
                  if (item.kind === "menu") {
                    setOpenMenu((current) => current === item.id ? "" : item.id);
                  } else if (item.id === "measure") {
                    selectTool("info-line");
                  } else if (item.id === "zoom") {
                    onZoomIn();
                  } else if (item.id === "lock") {
                    onSelectTool("");
                    onToggleLock();
                  }
                }}
              ><Icon size={16} strokeWidth={1.6} /></button>
              {isOpen && <div className="drawing-tool-menu" role="menu" aria-label={`${item.label} tools`}>
                {item.id === "cursor" && <>
                  <div className="drawing-tool-menu-heading">Cursor</div>
                  {[
                    ["cross", "Cross", Crosshair],
                    ["dot", "Dot", CircleDot],
                    ["arrow", "Arrow", MousePointer2],
                    ["eraser", "Eraser", Trash2],
                  ].map(([mode, label, ModeIcon]) => (
                    <button
                      key={mode}
                      type="button"
                      role="menuitemradio"
                      aria-checked={cursorMode === mode}
                      className={`drawing-tool-option ${cursorMode === mode ? "drawing-tool-option-active" : ""}`}
                      onClick={() => {
                        onSelectTool("");
                        onSetCursorMode(mode);
                        setOpenMenu("");
                      }}
                    ><ModeIcon size={15} /><span>{label}</span></button>
                  ))}
                </>}
                {(item.id === "lines" || item.id === "fibonacci" || item.id === "brushes") &&
                  DRAWING_TOOL_GROUPS.filter((group) =>
                    item.id === "brushes"
                      ? group.id === "shapes"
                      : item.id === "fibonacci"
                      ? group.id === "fibonacci"
                      : ["lines", "channels", "pitchforks"].includes(group.id)
                  ).map((group) => (
                    <section className="drawing-tool-menu-section" key={group.id}>
                      <div className="drawing-tool-menu-heading">{group.label}</div>
                      {group.tools.map((tool) => {
                        const ToolIcon = tool.icon;
                        return (
                          <button
                            key={tool.id}
                            type="button"
                            className={`drawing-tool-option ${selectedTool === tool.id ? "drawing-tool-option-active" : ""}`}
                            role="menuitem"
                            onClick={() => selectTool(tool.id)}
                          ><ToolIcon size={15} /><span>{tool.label}</span>{tool.shortcut && <kbd>{tool.shortcut}</kbd>}</button>
                        );
                      })}
                    </section>
                  ))}
                {item.id === "magnet" && <>
                  <div className="drawing-tool-menu-heading">Magnet</div>
                  {[
                    ["weak", "Weak Magnet"],
                    ["strong", "Strong Magnet"],
                    ["off", "Magnet Off"],
                  ].map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      role="menuitemradio"
                      aria-checked={magnetMode === mode}
                      className={`drawing-tool-option ${magnetMode === mode ? "drawing-tool-option-active" : ""}`}
                      onClick={() => { onSetMagnetMode(mode); setOpenMenu(""); }}
                    ><Magnet size={15} /><span>{label}</span></button>
                  ))}
                </>}
                {item.id === "visibility" && <>
                  <button type="button" role="menuitemcheckbox" aria-checked={!drawingsVisible} className="drawing-tool-option" onClick={onToggleVisibility}><Eye size={15} /><span>{drawingsVisible ? "Hide drawings" : "Show drawings"}</span></button>
                  <button type="button" role="menuitemcheckbox" aria-checked={!positionsVisible} className="drawing-tool-option" onClick={onTogglePositionsVisibility}><Eye size={15} /><span>{positionsVisible ? "Hide positions & orders" : "Show positions & orders"}</span></button>
                  <button type="button" role="menuitem" className="drawing-tool-option" onClick={onHideAll}><Eye size={15} /><span>{drawingsVisible || positionsVisible ? "Hide all" : "Show all"}</span></button>
                  {hiddenDrawings.length > 0 && <>
                    <div className="drawing-tool-menu-heading">Hidden drawings</div>
                    {hiddenDrawings.map((drawing, index) => (
                      <button
                        key={drawing.id}
                        type="button"
                        role="menuitem"
                        className="drawing-tool-option"
                        onClick={() => onShowDrawing(drawing.id)}
                      ><Eye size={15} /><span>Show {DRAWING_TOOL_BY_ID.get(drawing.type)?.label || "drawing"} {index + 1}</span></button>
                    ))}
                  </>}
                </>}
                {item.id === "remove" && <>
                  <button type="button" role="menuitem" className="drawing-tool-option" disabled={!drawingCount || (lockedDrawingCount === drawingCount && !alwaysRemoveLocked)} onClick={onRemoveLatestDrawing}><Trash2 size={15} /><span>Remove 1 drawing</span></button>
                  <button type="button" role="menuitem" className="drawing-tool-option" disabled={!drawingCount || (lockedDrawingCount === drawingCount && !alwaysRemoveLocked)} onClick={onClearDrawings}><Trash2 size={15} /><span>Remove all drawings</span></button>
                  <label className="drawing-tool-option drawing-tool-toggle">
                    <span>Always remove locked drawings</span>
                    <input type="checkbox" checked={alwaysRemoveLocked} onChange={onToggleAlwaysRemoveLocked} />
                  </label>
                </>}
              </div>}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function getExtendedLine(start, end, width, height, extendStart, extendEnd) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (!length) return [{ start, end }];
  const distance = Math.max(width, height) * 2;
  const unitX = dx / length;
  const unitY = dy / length;
  return [{
    start: extendStart ? { x: start.x - unitX * distance, y: start.y - unitY * distance } : start,
    end: extendEnd ? { x: end.x + unitX * distance, y: end.y + unitY * distance } : end,
  }];
}

function getRegressionSegments(drawing, data, timeToCoordinate, priceToCoordinate, width, height) {
  const [first, last] = drawing.points;
  const startTime = Number(first.time);
  const endTime = Number(last.time);
  const lowTime = Math.min(startTime, endTime);
  const highTime = Math.max(startTime, endTime);
  const samples = data.filter((candle) => candle.time >= lowTime && candle.time <= highTime);
  if (samples.length < 2 || lowTime === highTime) {
    const coords = drawing.points.map((point) => ({
      x: timeToCoordinate(point.time),
      y: priceToCoordinate(point.price),
    }));
    return { lines: getExtendedLine(coords[0], coords[1], width, height, false, false) };
  }

  const meanX = samples.reduce((sum, candle) => sum + candle.time, 0) / samples.length;
  const meanY = samples.reduce((sum, candle) => sum + candle.close, 0) / samples.length;
  const denominator = samples.reduce((sum, candle) => sum + (candle.time - meanX) ** 2, 0);
  if (!denominator) return { lines: [] };
  const slope = samples.reduce((sum, candle) =>
    sum + (candle.time - meanX) * (candle.close - meanY), 0
  ) / denominator;
  const intercept = meanY - slope * meanX;
  const deviation = Math.max(...samples.map((candle) =>
    Math.abs(candle.close - (intercept + slope * candle.time))
  ));
  const timeA = Math.min(first.time, last.time);
  const timeB = Math.max(first.time, last.time);
  const priceA = intercept + slope * timeA;
  const priceB = intercept + slope * timeB;
  const xA = timeToCoordinate(timeA);
  const xB = timeToCoordinate(timeB);
  const centerA = priceToCoordinate(priceA);
  const centerB = priceToCoordinate(priceB);
  const upperA = priceToCoordinate(priceA + deviation);
  const upperB = priceToCoordinate(priceB + deviation);
  const lowerA = priceToCoordinate(priceA - deviation);
  const lowerB = priceToCoordinate(priceB - deviation);
  if (![xA, xB, centerA, centerB, upperA, upperB, lowerA, lowerB].every(Number.isFinite)) {
    return { lines: [] };
  }
  return {
    lines: [
      { start: { x: xA, y: centerA }, end: { x: xB, y: centerB } },
      { start: { x: xA, y: upperA }, end: { x: xB, y: upperB } },
      { start: { x: xA, y: lowerA }, end: { x: xB, y: lowerB } },
    ],
  };
}

function getDrawingGeometry(drawing, pointCoordinates, data, timeToCoordinate, priceToCoordinate, width, height) {
  const [first, second, third] = pointCoordinates;
  if (!first || !Number.isFinite(first.x) || !Number.isFinite(first.y)) return { lines: [] };
  const fullWidth = Math.max(0, width - 72);
  const fullHeight = Math.max(0, height - 28);

  if (drawing.type === "horizontal-line") {
    return { lines: [{ start: { x: 0, y: first.y }, end: { x: fullWidth, y: first.y } }] };
  }
  if (drawing.type === "horizontal-ray") {
    return { lines: [{ start: first, end: { x: fullWidth, y: first.y } }] };
  }
  if (drawing.type === "vertical-line") {
    return { lines: [{ start: { x: first.x, y: 0 }, end: { x: first.x, y: fullHeight } }] };
  }
  if (drawing.type === "cross-line") {
    return {
      lines: [
        { start: { x: first.x, y: 0 }, end: { x: first.x, y: fullHeight } },
        { start: { x: 0, y: first.y }, end: { x: fullWidth, y: first.y } },
      ],
    };
  }
  if (drawing.type === "fib-retracement" && second && Number.isFinite(second.y)) {
    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    const priceRange = drawing.points[1].price - drawing.points[0].price;
    return {
      lines: levels.map((level) => {
        const y = priceToCoordinate(drawing.points[0].price + priceRange * level);
        return {
          start: { x: Math.min(first.x, second.x), y },
          end: { x: Math.max(first.x, second.x), y },
        };
      }).filter((line) => Number.isFinite(line.start.y)),
      labels: levels.map((level) => {
        const price = drawing.points[0].price + priceRange * level;
        return {
          x: Math.max(first.x, second.x) + 4,
          y: priceToCoordinate(price),
          text: `${(level * 100).toFixed(1)}%`,
        };
      }).filter((label) => Number.isFinite(label.y)),
    };
  }
  if (drawing.type === "rectangle" && second && Number.isFinite(second.x) && Number.isFinite(second.y)) {
    const left = Math.min(first.x, second.x);
    const right = Math.max(first.x, second.x);
    const top = Math.min(first.y, second.y);
    const bottom = Math.max(first.y, second.y);
    return {
      lines: [
        { start: { x: left, y: top }, end: { x: right, y: top } },
        { start: { x: right, y: top }, end: { x: right, y: bottom } },
        { start: { x: right, y: bottom }, end: { x: left, y: bottom } },
        { start: { x: left, y: bottom }, end: { x: left, y: top } },
      ],
    };
  }
  if (!second || !Number.isFinite(second.x) || !Number.isFinite(second.y)) return { lines: [] };
  if (drawing.type === "ray") {
    return { lines: getExtendedLine(first, second, width, height, false, true) };
  }
  if (drawing.type === "extended-line") {
    return { lines: getExtendedLine(first, second, width, height, true, true) };
  }
  if (drawing.type === "regression-trend") {
    return getRegressionSegments(drawing, data, timeToCoordinate, priceToCoordinate, width, height);
  }
  if (drawing.type === "flat-top-bottom" && third && Number.isFinite(third.y)) {
    const left = Math.min(first.x, second.x);
    const right = Math.max(first.x, second.x);
    return {
      lines: [
        { start: { x: left, y: first.y }, end: { x: right, y: first.y } },
        { start: { x: left, y: third.y }, end: { x: right, y: third.y } },
        { start: { x: left, y: first.y }, end: { x: left, y: third.y } },
        { start: { x: right, y: first.y }, end: { x: right, y: third.y } },
      ],
    };
  }
  if (
    ["parallel-channel", "disjoint-channel"].includes(drawing.type) &&
    third &&
    Number.isFinite(third.x) &&
    Number.isFinite(third.y)
  ) {
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const length = Math.hypot(dx, dy);
    if (!length) return { lines: [] };
    const normal = { x: -dy / length, y: dx / length };
    const offsetAmount = (third.x - first.x) * normal.x + (third.y - first.y) * normal.y;
    const offset = { x: normal.x * offsetAmount, y: normal.y * offsetAmount };
    const shiftedFirst = { x: first.x + offset.x, y: first.y + offset.y };
    const shiftedSecond = { x: second.x + offset.x, y: second.y + offset.y };
    const lines = [
      { start: first, end: second },
      { start: shiftedFirst, end: shiftedSecond },
    ];
    if (drawing.type === "parallel-channel") {
      lines.push({ start: first, end: shiftedFirst }, { start: second, end: shiftedSecond });
    }
    return { lines };
  }
  if (
    ["pitchfork", "schiff-pitchfork", "modified-schiff-pitchfork", "inside-pitchfork"].includes(drawing.type) &&
    third &&
    Number.isFinite(third.x) &&
    Number.isFinite(third.y)
  ) {
    let pivot = first;
    if (drawing.type === "schiff-pitchfork") {
      pivot = { x: first.x, y: (first.y + second.y) / 2 };
    } else if (drawing.type === "modified-schiff-pitchfork") {
      pivot = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    } else if (drawing.type === "inside-pitchfork") {
      pivot = { x: first.x, y: first.y + (second.y - first.y) * 0.25 };
    }
    const median = { x: (second.x + third.x) / 2, y: (second.y + third.y) / 2 };
    return {
      lines: [
        ...getExtendedLine(pivot, median, width, height, false, true),
        ...getExtendedLine(second, { x: second.x + median.x - pivot.x, y: second.y + median.y - pivot.y }, width, height, false, true),
        ...getExtendedLine(third, { x: third.x + median.x - pivot.x, y: third.y + median.y - pivot.y }, width, height, false, true),
      ],
    };
  }
  return { lines: getExtendedLine(first, second, width, height, false, false) };
}
const EXCHANGE_TIME_ZONES = {
  AUS200: "Australia/Sydney",
  GER40: "Europe/Berlin",
  UK100: "Europe/London",
  US30: "America/New_York",
  US500: "America/New_York",
  USTEC: "America/New_York",
};
const FALLBACK_TIME_ZONES = [
  "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Phoenix",
  "America/Vancouver", "America/Denver", "America/Mexico_City", "America/Chicago",
  "America/Bogota", "America/Lima", "America/New_York", "America/Toronto",
  "America/Sao_Paulo", "Atlantic/Reykjavik", "Europe/London", "Europe/Paris",
  "Europe/Berlin", "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata",
  "Asia/Bangkok", "Asia/Singapore", "Asia/Shanghai", "Asia/Tokyo",
  "Australia/Sydney", "Pacific/Auckland",
];
const SUPPORTED_TIME_ZONES = typeof Intl.supportedValuesOf === "function"
  ? Intl.supportedValuesOf("timeZone")
  : FALLBACK_TIME_ZONES;

function isValidTimeZone(timeZone) {
  if (timeZone === "UTC" || timeZone === "Exchange") return true;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function getInitialChartTimeZone() {
  try {
    const savedTimeZone = localStorage.getItem("df-terminal-chart-timezone");
    if (savedTimeZone && isValidTimeZone(savedTimeZone)) return savedTimeZone;
  } catch (error) {
    console.warn("Unable to load the saved chart time zone.", error);
  }
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return browserTimeZone && isValidTimeZone(browserTimeZone) ? browserTimeZone : "UTC";
}

function getExchangeTimeZone(symbol) {
  return EXCHANGE_TIME_ZONES[symbol?.toUpperCase()] || "UTC";
}

function getResolvedTimeZone(timeZone, symbol) {
  return timeZone === "Exchange" ? getExchangeTimeZone(symbol) : timeZone;
}

function formatTimeZoneOffset(timeZone, date) {
  const zoneName = new Intl.DateTimeFormat("en", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  if (!zoneName || zoneName === "GMT" || zoneName === "UTC") return "UTC";
  const match = zoneName.match(/^GMT([+-])(\d{2})(?::(\d{2}))?$/);
  if (!match) return zoneName.replace(/^GMT/, "UTC");
  const [, sign, rawHours, minutes = "00"] = match;
  const hours = Number(rawHours);
  return minutes === "00" ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${minutes}`;
}

function timeToDate(time) {
  if (typeof time === "number") return new Date(time * 1000);
  if (typeof time === "string") return new Date(time);
  if (time && typeof time === "object" && "year" in time && "month" in time && "day" in time) {
    return new Date(Date.UTC(time.year, time.month - 1, time.day));
  }
  return null;
}

function formatChartTime(time, timeZone, tickMarkType) {
  const date = timeToDate(time);
  if (!date || Number.isNaN(date.getTime())) return null;
  const options = tickMarkType === TickMarkType.Year
    ? { year: "numeric" }
    : tickMarkType === TickMarkType.Month
      ? { month: "short" }
      : tickMarkType === TickMarkType.DayOfMonth
        ? { day: "2-digit" }
        : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  return new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(date);
}

function formatChartCrosshairTime(time, timeZone) {
  const date = timeToDate(time);
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatChartRangeTimestamp(timestampMs, timeZone) {
  if (!Number.isFinite(timestampMs)) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(new Date(timestampMs));
}

function formatChartClock(date, timeZone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function ChartTimezonePicker({ timeZone, exchangeTimeZone, now, onSelect }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const pickerRef = useRef(null);
  const selectedZone = timeZone === "Exchange" ? exchangeTimeZone : timeZone;
  const displayedZone = timeZone === "Exchange" ? exchangeTimeZone : timeZone;
  const searchValue = search.trim().toLowerCase();
  const zoneOptions = useMemo(() => {
    if (!open) return [];
    const date = new Date(now);
    return SUPPORTED_TIME_ZONES.map((zone) => ({
      zone,
      city: zone.split("/").pop().replace(/_/g, " "),
      offset: formatTimeZoneOffset(zone, date),
      offsetMinutes: getTimeZoneOffsetMinutes(zone, date),
    })).sort((a, b) =>
      a.offsetMinutes - b.offsetMinutes || a.city.localeCompare(b.city)
    );
  }, [open, Math.floor(now / 60000)]);
  const visibleZones = zoneOptions.filter(({ zone, city, offset }) =>
    !searchValue || `${zone} ${city} ${offset}`.toLowerCase().includes(searchValue)
  );
  const clockText = `${formatChartClock(new Date(now), selectedZone)} ${formatTimeZoneOffset(selectedZone, new Date(now))}`;

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (!pickerRef.current?.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function chooseTimeZone(value) {
    onSelect(value);
    setSearch("");
    setOpen(false);
  }

  return (
    <div className="chart-timezone-picker" ref={pickerRef}>
      <button
        className="chart-timezone-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Chart time ${clockText}. Time zone: ${timeZone === "Exchange" ? `Exchange (${displayedZone})` : timeZone}. Change time zone`}
        title={`${timeZone === "Exchange" ? `Exchange (${displayedZone})` : timeZone} · click to change`}
        onClick={() => setOpen((current) => !current)}
      >
        <Clock3 size={13} />
        <span>{clockText}</span>
        <ChevronDown size={12} />
      </button>
      {open && <div className="chart-timezone-menu">
        <label className="chart-timezone-search">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search time zones"
            aria-label="Search time zones"
          />
        </label>
        <div className="chart-timezone-options" role="listbox" aria-label="Chart time zone">
          {[
            ["UTC", "UTC"],
            ["Exchange", `Exchange · ${exchangeTimeZone}`],
          ].filter(([value, label]) =>
            !searchValue || `${value} ${label}`.toLowerCase().includes(searchValue)
          ).map(([value, label]) => (
            <button
              key={value}
              className={`chart-timezone-option ${timeZone === value ? "chart-timezone-option-selected" : ""}`}
              type="button"
              role="option"
              aria-selected={timeZone === value}
              onClick={() => chooseTimeZone(value)}
            >{label}</button>
          ))}
          <div className="chart-timezone-divider" />
          {visibleZones.map(({ zone, city, offset }) => (
            <button
              key={zone}
              className={`chart-timezone-option ${timeZone === zone ? "chart-timezone-option-selected" : ""}`}
              type="button"
              role="option"
              aria-selected={timeZone === zone}
              title={zone}
              onClick={() => chooseTimeZone(zone)}
            >({offset}) {city}</button>
          ))}
          {visibleZones.length === 0 && <div className="chart-timezone-empty">No matching time zones</div>}
        </div>
      </div>}
    </div>
  );
}

function getTimeZoneOffsetMinutes(timeZone, date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = Number(part.value);
    return result;
  }, {});
  const roundedDate = Math.floor(date.getTime() / 1000) * 1000;
  const zoneDate = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (zoneDate - roundedDate) / 60000;
}
const TRADING_ERROR_MESSAGES = {
  authentication_required: "Sign in with your Daily Funded account to use trading.",
  trading_disabled: "Trading is disabled until this account is approved and active.",
  trading_account_not_found: "This trading account is unavailable.",
  trading_account_unavailable: "This trading account is unavailable.",
  account_lookup_failed: "Account service is unavailable. Try again shortly.",
  market_unavailable: "Current market data is unavailable. No order was placed.",
  stale_quote: "The quote is stale or the market is closed. No order was placed.",
  invalid_volume: "The order volume is invalid for this symbol or account.",
  invalid_tp: "Take profit must be on the profitable side of the current executable price.",
  invalid_sl: "Stop loss must be on the protective side of the current executable price.",
  insufficient_margin: "There is not enough available margin for this order.",
  rule_violation: "The order violates this account's trading rules.",
  position_not_found: "Position not found or not available to this user.",
  unauthorized_action: "This action is not authorized.",
  invalid_order_type: "Only market orders are currently supported.",
  worker_timeout: "Trading service timed out. Try again shortly.",
  worker_network_error: "Trading service is unavailable. Try again shortly.",
  worker_http_error: "Trading service could not process the request.",
  worker_rejected: "Trading service rejected the request.",
  worker_response_invalid: "Trading service returned an invalid response.",
  server_response_invalid: "Trading service returned an invalid position.",
  server_error: "Trading service is unavailable. Try again shortly.",
};
const CATEGORY_SECTIONS = [
  { key: "FOREX", label: "Forex" },
  { key: "METALS", label: "Metals" },
  { key: "CRYPTO", label: "Crypto" },
  { key: "ENERGY", label: "Energy" },
  { key: "INDEX", label: "Indices" },
];
const SHORT_NAMES = {
  AUS200: "Australia 200",
  BTCUSD: "Bitcoin / US Dollar",
  ETHUSD: "Ethereum / US Dollar",
  EURUSD: "Euro / US Dollar",
  GER40: "Germany 40",
  GBPUSD: "Pound / US Dollar",
  UK100: "UK 100",
  UKOIL: "Brent Crude",
  US30: "Wall Street 30",
  US500: "US 500",
  USOIL: "WTI Crude",
  USDJPY: "US Dollar / Yen",
  USTEC: "US Tech 100",
  XAGUSD: "Silver / US Dollar",
  XAUUSD: "Gold / US Dollar",
  XCUUSD: "Copper / US Dollar",
  XNGUSD: "Natural Gas / US Dollar",
};
const INSTRUMENT_MARKS = {
  AUS200: { kind: "regional-index", flag: "au", label: "Australia 200" },
  BTCUSD: { kind: "bitcoin", label: "Bitcoin" },
  ETHUSD: { kind: "ethereum", label: "Ethereum" },
  EURUSD: { kind: "pair", flags: ["eu", "us"], label: "Euro and US flags" },
  GER40: { kind: "regional-index", flag: "de", label: "Germany 40" },
  GBPUSD: { kind: "pair", flags: ["gb", "us"], label: "UK and US flags" },
  UK100: { kind: "regional-index", flag: "gb", label: "UK 100" },
  UKOIL: { kind: "oil-drop", label: "Brent crude" },
  US30: { kind: "regional-index", flag: "us", label: "Wall Street 30" },
  US500: { kind: "regional-index", flag: "us", label: "US 500" },
  USOIL: { kind: "oil-drop", label: "WTI crude" },
  USDJPY: { kind: "pair", flags: ["us", "jp"], label: "US and Japan flags" },
  USTEC: { kind: "regional-index", flag: "us", label: "US Tech 100" },
  XAGUSD: { kind: "quoted-metal", flag: "us", label: "Silver / US Dollar" },
  XAUUSD: { kind: "quoted-gold", flag: "us", label: "Gold / US Dollar" },
  XCUUSD: { kind: "quoted-copper", flag: "us", label: "Copper / US Dollar" },
  XNGUSD: { kind: "gas-flame", label: "Natural gas" },
};

let terminalFirebaseAuth;

function getTerminalFirebaseAuth() {
  if (terminalFirebaseAuth) return terminalFirebaseAuth;
  const firebase = window.firebase;
  if (!firebase) throw new Error(TRADING_ERROR_MESSAGES.authentication_required);
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  terminalFirebaseAuth = firebase.auth();
  return terminalFirebaseAuth;
}

class TradingRequestError extends Error {
  constructor(code, status) {
    super(TRADING_ERROR_MESSAGES[code] || TRADING_ERROR_MESSAGES.server_error);
    this.code = code;
    this.status = status;
  }
}

async function getTradingJson(path, user, options = {}) {
  if (!user) throw new TradingRequestError("authentication_required", 401);
  let token;
  try {
    token = await user.getIdToken();
  } catch {
    throw new TradingRequestError("authentication_required", 401);
  }
  let response;
  try {
    response = await fetch(`${TRADING_API_BASE}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });
  } catch {
    throw new TradingRequestError("server_error", 0);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new TradingRequestError("server_error", response.status);
  }
  if (!response.ok) {
    const code = payload.code ||
      (response.status === 401 ? "authentication_required" :
        response.status === 403 ? "unauthorized_action" :
          response.status === 404 ? "position_not_found" :
            response.status === 409 ? "trading_disabled" : "server_error");
    throw new TradingRequestError(code, response.status);
  }
  return payload;
}

function useTradingSession() {
  const [authStatus, setAuthStatus] = useState("loading");
  const [user, setUser] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [account, setAccount] = useState(null);
  const [rules, setRules] = useState(null);
  const [positions, setPositions] = useState([]);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const confirmedPositionVersion = useRef(0);
  const confirmedPositions = useRef(new Map());
  const closedPositionIds = useRef(new Set());
  const livePositionMarks = useRef(new Map());
  const loadedAccountId = useRef(null);
  const [trades, setTrades] = useState([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const positionEventState = useRef({ positions, trades, account, closedIds: closedPositionIds.current });
  positionEventState.current = {
    ...positionEventState.current,
    positions,
    trades,
    account,
    closedIds: closedPositionIds.current,
  };

  const clearPositionTracking = useCallback(() => {
    confirmedPositionVersion.current = 0;
    confirmedPositions.current.clear();
    closedPositionIds.current.clear();
    livePositionMarks.current.clear();
  }, []);

  const reconcilePositions = useCallback((serverPositions, refreshVersionAtStart) => {
    const byId = new Map(
      serverPositions
        .filter((position) =>
          position &&
          typeof position.id === "string" &&
          !closedPositionIds.current.has(position.id)
        )
        .map((position) => [position.id, position])
    );

    for (const [id, confirmed] of confirmedPositions.current) {
      if (closedPositionIds.current.has(id)) {
        confirmedPositions.current.delete(id);
        livePositionMarks.current.delete(id);
        continue;
      }
      if (confirmed.version > refreshVersionAtStart) {
        byId.set(id, confirmed.position);
      } else if (byId.has(id)) {
        confirmedPositions.current.delete(id);
      } else {
        confirmedPositions.current.delete(id);
        livePositionMarks.current.delete(id);
      }
    }

    const reconciled = [...byId.values()].map((position) => {
      const liveMark = livePositionMarks.current.get(position.id);
      if (position.status === "open" && liveMark) {
        return {
          ...position,
          current_price: liveMark.current_price,
          floating_pnl: liveMark.floating_pnl,
          live_tick_at: liveMark.timestampMs,
        };
      }
      if (position.status !== "open") livePositionMarks.current.delete(position.id);
      return position;
    });
    const activeIds = new Set(reconciled.map((position) => position.id));
    for (const id of livePositionMarks.current.keys()) {
      if (!activeIds.has(id)) livePositionMarks.current.delete(id);
    }
    return reconciled;
  }, []);

  const addConfirmedPosition = useCallback((position) => {
    if (!position || typeof position.id !== "string" || position.status !== "open") {
      throw new TradingRequestError("server_error", 502);
    }
    if (closedPositionIds.current.has(position.id)) return;
    confirmedPositionVersion.current += 1;
    confirmedPositions.current.set(position.id, {
      position,
      version: confirmedPositionVersion.current,
    });
    const liveMark = livePositionMarks.current.get(position.id);
    const displayedPosition = liveMark
      ? {
        ...position,
        current_price: liveMark.current_price,
        floating_pnl: liveMark.floating_pnl,
        live_tick_at: liveMark.timestampMs,
      }
      : position;
    setPositions((current) => [
      displayedPosition,
      ...current.filter((item) => item.id !== position.id),
    ]);
  }, []);

  const removeClosedPosition = useCallback((positionId) => {
    closedPositionIds.current.add(positionId);
    confirmedPositions.current.delete(positionId);
    livePositionMarks.current.delete(positionId);
    setPositions((current) => current.filter((position) => position.id !== positionId));
  }, []);

  const applyAuthoritativePositionEvent = useCallback((event) => {
    const current = positionEventState.current;
    const next = applyPositionEvent(current, event);
    if (next === current) return;
    closedPositionIds.current = next.closedIds;
    positionEventState.current = next;
    setPositions(next.positions || []);
    if (next.trades !== current.trades) setTrades(next.trades || []);
    if (next.account !== current.account) setAccount(next.account || null);
    if (event.type === "POSITION_CLOSED") {
      setRefreshVersion((version) => version + 1);
    }
  }, []);

  const applyLiveTickToPositions = useCallback((tick) => {
    if (!Number.isFinite(tick.timestampMs)) return;
    const updates = new Map();
    for (const position of positionsRef.current) {
      if (position.status !== "open" || position.symbol?.toUpperCase() !== tick.symbol) continue;
      const markPrice = position.side === "BUY" ? tick.bid : position.side === "SELL" ? tick.ask : null;
      const floatingPnl = calculateDisplayFloatingPnl(position, markPrice);
      if (floatingPnl === null) continue;
      const previous = livePositionMarks.current.get(position.id);
      if (previous && tick.timestampMs < previous.timestampMs) continue;
      const mark = { timestampMs: tick.timestampMs, current_price: markPrice, floating_pnl: floatingPnl };
      livePositionMarks.current.set(position.id, mark);
      updates.set(position.id, mark);
    }
    if (!updates.size) return;
    setPositions((current) => current.map((position) => {
      const mark = updates.get(position.id);
      return mark && position.status === "open"
        ? {
          ...position,
          current_price: mark.current_price,
          floating_pnl: mark.floating_pnl,
          live_tick_at: mark.timestampMs,
        }
        : position;
    }));
  }, []);

  useEffect(() => {
    let unsubscribe;
    let disposed = false;
    try {
      const auth = getTerminalFirebaseAuth();
      auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL)
        .then(() => {
          if (disposed) return;
          unsubscribe = auth.onAuthStateChanged((nextUser) => {
            setUser(nextUser);
            setAuthStatus(nextUser ? "signed-in" : "signed-out");
            setAccounts([]);
            setSelectedAccountId("");
            setAccount(null);
            setRules(null);
            setPositions([]);
            setTrades([]);
            setError("");
          }, () => {
            setAuthStatus("unavailable");
            setError(TRADING_ERROR_MESSAGES.authentication_required);
          });
        })
        .catch(() => {
          if (disposed) return;
          setAuthStatus("unavailable");
          setAccountsLoading(false);
          setError(TRADING_ERROR_MESSAGES.authentication_required);
        });
    } catch {
      setAuthStatus("unavailable");
      setAccountsLoading(false);
      setError(TRADING_ERROR_MESSAGES.authentication_required);
    }
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setAccounts([]);
      setSelectedAccountId("");
      setAccountsLoading(authStatus === "loading");
      return undefined;
    }
    let disposed = false;
    setAccountsLoading(true);
    getTradingJson("/my/accounts", user)
      .then((rows) => {
        if (disposed) return;
        const ownedAccounts = Array.isArray(rows) ? rows : [];
        setAccounts(ownedAccounts);
        setSelectedAccountId((current) =>
          ownedAccounts.some((item) => item.id === current)
            ? current
            : ownedAccounts.find((item) => item.status === "active" && item.tradingEnabled)?.id ||
              ownedAccounts[0]?.id ||
              ""
        );
        setError("");
      })
      .catch((requestError) => {
        if (disposed) return;
        setError(requestError.message);
      })
      .finally(() => {
        if (!disposed) setAccountsLoading(false);
      });
    return () => { disposed = true; };
  }, [user]);

  const selectedAccount = accounts.find((item) => item.id === selectedAccountId) || null;
  const canTrade = Boolean(
    user &&
    selectedAccount &&
    selectedAccount.status === "active" &&
    selectedAccount.tradingEnabled === true
  );

  useEffect(() => {
    if (!user || !selectedAccount) {
      loadedAccountId.current = null;
      clearPositionTracking();
      setDataLoading(false);
      setAccount(null);
      setRules(null);
      setPositions([]);
      setTrades([]);
      return undefined;
    }
    if (!canTrade) {
      loadedAccountId.current = null;
      clearPositionTracking();
      setDataLoading(false);
      setAccount(null);
      setRules(null);
      setPositions([]);
      setTrades([]);
      setError(TRADING_ERROR_MESSAGES.trading_disabled);
      return undefined;
    }

    let disposed = false;
    let inFlight = false;
    const controller = new AbortController();
    if (loadedAccountId.current !== selectedAccount.id) {
      loadedAccountId.current = selectedAccount.id;
      clearPositionTracking();
      setAccount(null);
      setRules(null);
      setPositions([]);
      setTrades([]);
    }
    setDataLoading(true);
    setError("");
    const refresh = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      const refreshVersionAtStart = confirmedPositionVersion.current;
      try {
        const accountQuery = `?account_id=${encodeURIComponent(selectedAccount.id)}`;
        const [accountResult, rulesResult, tradesResult] = await Promise.all([
          getTradingJson(`/trading/accounts${accountQuery}`, user, { signal: controller.signal }),
          getTradingJson(`/trading/account-rules${accountQuery}`, user, { signal: controller.signal }),
          getTradingJson(`/trading/trades${accountQuery}`, user, { signal: controller.signal }),
        ]);
        if (disposed) return;
        setAccount(accountResult.account || null);
        setPositions(reconcilePositions(
          Array.isArray(accountResult.positions) ? accountResult.positions : [],
          refreshVersionAtStart
        ));
        setRules(rulesResult.rules || accountResult.rules || null);
        setTrades(Array.isArray(tradesResult.trades) ? tradesResult.trades : []);
        setError("");
      } catch (requestError) {
        if (disposed || requestError.name === "AbortError") return;
        setError(requestError.message);
        setAccount(null);
        setRules(null);
        setTrades([]);
      } finally {
        if (!disposed) setDataLoading(false);
        inFlight = false;
      }
    };
    refresh();
    const timer = window.setInterval(refresh, TRADING_POLL_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [user, selectedAccount?.id, canTrade, refreshVersion, clearPositionTracking, reconcilePositions]);

  useEffect(() => {
    if (!user || !selectedAccount) return undefined;
    let disposed = false;
    let retryTimer = null;
    let socket = null;

    const connect = async () => {
      try {
        const ticketResult = await getTradingJson("/trading/events/token", user, {
          method: "POST",
          body: JSON.stringify({ account_id: selectedAccount.id }),
        });
        if (disposed) return;
        const ticket = encodeURIComponent(ticketResult.ticket);
        const nextSocket = new WebSocket(`${TRADING_EVENTS_URL}?ticket=${ticket}`);
        socket = nextSocket;
        nextSocket.onmessage = (message) => {
          try {
            const event = JSON.parse(message.data);
            if (event.account_id === selectedAccount.id) applyAuthoritativePositionEvent(event);
          } catch (eventError) {
            console.error("Unable to apply authoritative position event:", eventError);
          }
        };
        nextSocket.onclose = () => {
          if (!disposed) retryTimer = window.setTimeout(connect, 2000);
        };
        nextSocket.onerror = () => nextSocket.close();
      } catch (connectionError) {
        if (disposed) return;
        console.error("Unable to connect to authoritative position events:", connectionError);
        retryTimer = window.setTimeout(connect, 5000);
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [user, selectedAccount?.id, applyAuthoritativePositionEvent]);

  return {
    authStatus,
    user,
    accounts,
    accountsLoading,
    selectedAccount,
    selectedAccountId,
    setSelectedAccountId,
    account,
    rules,
    positions,
    trades,
    dataLoading,
    error,
    canTrade,
    addConfirmedPosition,
    removeClosedPosition,
    applyAuthoritativePositionEvent,
    applyLiveTickToPositions,
    refresh: () => setRefreshVersion((current) => current + 1),
  };
}

function calculateDisplayFloatingPnl(position, markPrice) {
  const price = Number(markPrice);
  const openPrice = Number(position.open_price);
  const volume = Number(position.volume);
  const metadata = position.pnl_metadata;
  const contractSize = Number(metadata?.contract_size);
  const baseCurrency = typeof metadata?.base_currency === "string"
    ? metadata.base_currency.toUpperCase()
    : "";
  const quoteCurrency = typeof metadata?.quote_currency === "string"
    ? metadata.quote_currency.toUpperCase()
    : "";
  if (
    !Number.isFinite(price) || price <= 0 ||
    !Number.isFinite(openPrice) || openPrice <= 0 ||
    !Number.isFinite(volume) || volume <= 0 ||
    !Number.isFinite(contractSize) || contractSize <= 0 ||
    !baseCurrency || !quoteCurrency ||
    !["BUY", "SELL"].includes(position.side)
  ) return null;

  const direction = position.side === "BUY" ? 1 : -1;
  const quotePnl = direction * (price - openPrice) * volume * contractSize;
  if (quoteCurrency === "USD") return quotePnl;
  if (baseCurrency === "USD" && ["JPY", "CHF", "CAD"].includes(quoteCurrency)) {
    return quotePnl / price;
  }
  return null;
}

async function getJson(path, signal) {
  const response = await fetch(`${API_BASE}${path}`, { signal, headers: { Accept: "application/json" } });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The market service returned an unreadable response.");
  }
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `Market service error (${response.status}).`);
  }
  return payload;
}

function formatPrice(value, decimals = 5) {
  if (!Number.isFinite(Number(value)) || value === null) return "--";
  const digits = Math.min(Math.max(decimals, 0), 8);
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function getPositionPriceDigits(position) {
  const digits = Number(position?.pnl_metadata?.price_decimals);
  return Number.isInteger(digits) && digits >= 0 ? digits : getPriceDigits(position?.symbol);
}

function snapPriceToPositionPrecision(price, position) {
  const digits = Number(position?.pnl_metadata?.price_decimals);
  if (!Number.isInteger(digits) || digits < 0 || !Number.isFinite(price) || price <= 0) return null;
  const scale = 10 ** digits;
  return Number((Math.round(price * scale) / scale).toFixed(digits));
}

function formatSignedMoney(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
  const amount = Number(value);
  return `${amount >= 0 ? "+" : "-"}$${Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function getPriceDigits(symbol) {
  if (symbol?.includes("JPY")) return 3;
  if (["BTCUSD", "ETHUSD", "US30", "USTEC", "US500", "GER40", "UK100", "AUS200"].includes(symbol)) return 2;
  if (["XAUUSD", "UKOIL", "USOIL"].includes(symbol)) return 2;
  return 5;
}

function priceForWatchlist(quote, digits) {
  if (!quote) return "--";
  if (quote.bid !== null && quote.ask !== null) {
    return `${formatPrice(quote.bid, digits)} / ${formatPrice(quote.ask, digits)}`;
  }
  return quote.mid === null ? "--" : formatPrice(quote.mid, digits);
}

function getMarketState(quote, error) {
  if (error) return { label: "Unavailable", tone: "unavailable" };
  if (!quote) return { label: "Waiting", tone: "waiting" };
  if (quote.market_state?.toLowerCase() === "closed") return { label: "Market Closed", tone: "closed" };
  if (quote.stale) return { label: "Stale", tone: "stale" };
  return { label: "Live", tone: "live" };
}

function normalizeQuotePrice(value) {
  if (value === null || value === undefined || value === "") return null;
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function quoteTimestampMs(value) {
  if (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value))) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? (timestamp < 1e12 ? timestamp * 1000 : timestamp) : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function useMarketData(liveTickHandler, onAcceptedTick) {
  const [symbols, setSymbols] = useState([]);
  const [symbolState, setSymbolState] = useState("loading");
  const [symbolError, setSymbolError] = useState("");
  const [quotes, setQuotes] = useState({});
  const [quoteErrors, setQuoteErrors] = useState({});
  const [quoteRefresh, setQuoteRefresh] = useState("loading");
  const quoteTimes = useRef({});

  useEffect(() => {
    const controller = new AbortController();
    getJson("/market/symbols", controller.signal)
      .then((payload) => {
        const marketSymbols = Array.isArray(payload.symbols) ? payload.symbols : [];
        setSymbols(marketSymbols);
        setSymbolState(marketSymbols.length ? "ready" : "empty");
      })
      .catch((error) => {
        if (error.name === "AbortError") return;
        setSymbolError(error.message);
        setSymbolState("error");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!symbols.length) return undefined;
    let disposed = false;
    let starting = false;
    let streamReady = false;
    let retryTimer = null;
    let connection = null;
    let snapshotPromise = null;
    const marketSymbolRecords = symbols
      .filter((item) => item?.enabled !== false && item?.is_enabled !== false)
      .map((item) => ({
        symbol: item.symbol?.trim().toUpperCase(),
        provider: item.provider,
        providerSymbol: item.provider_symbol?.trim().toUpperCase(),
      }))
      .filter((item) => item.symbol);
    const canonicalSymbols = [...new Set(marketSymbolRecords.map((item) => item.symbol))];
    if (!canonicalSymbols.length) return undefined;
    const enabledSymbols = new Set(canonicalSymbols);
    const canonicalSymbolsByProviderSymbol = new Map();
    for (const item of marketSymbolRecords) {
      if (item.provider !== "biquote" || !item.providerSymbol) continue;
      const mappedSymbols = canonicalSymbolsByProviderSymbol.get(item.providerSymbol) || [];
      mappedSymbols.push(item.symbol);
      canonicalSymbolsByProviderSymbol.set(item.providerSymbol, mappedSymbols);
    }
    const providerSymbols = [...canonicalSymbolsByProviderSymbol.keys()];
    const liveMappedSymbols = new Set([...canonicalSymbolsByProviderSymbol.values()].flat());
    const unmappedSymbols = canonicalSymbols.filter((symbol) => !liveMappedSymbols.has(symbol));
    if (unmappedSymbols.length) {
      setQuoteErrors((current) => ({
        ...current,
        ...Object.fromEntries(unmappedSymbols.map((symbol) => [symbol, {
          symbol,
          code: "provider_mapping_missing",
          message: "No Biquote live symbol mapping is configured.",
        }])),
      }));
    }

    const markQuotesStale = () => {
      streamReady = false;
      setQuoteRefresh("error");
      setQuotes((current) => Object.fromEntries(Object.entries(current).map(([symbol, quote]) => [
        symbol,
        { ...quote, bid: null, ask: null, mid: null, stale: true },
      ])));
    };

    const applyQuote = (quote, timestamp, preserveMarketState = false) => {
      const previousTimestamp = quoteTimes.current[quote.symbol];
      if (previousTimestamp !== undefined && (timestamp === null || timestamp < previousTimestamp)) return false;
      if (timestamp !== null) quoteTimes.current[quote.symbol] = timestamp;
      setQuotes((current) => {
        const previous = current[quote.symbol];
        const nextQuote = preserveMarketState && quote.market_state == null && previous?.market_state
          ? { ...quote, market_state: previous.market_state }
          : quote;
        return { ...current, [quote.symbol]: nextQuote };
      });
      return true;
    };

    const refreshSnapshot = () => {
      if (disposed || document.hidden) return Promise.resolve(null);
      if (snapshotPromise) return snapshotPromise;
      setQuoteRefresh((current) => current === "loading" ? "loading" : "refreshing");
      snapshotPromise = (async () => {
        try {
          const query = canonicalSymbols.join(",");
          const payload = await getJson(`/market/quotes?symbols=${encodeURIComponent(query)}`);
          if (disposed) return null;
          const nextErrors = {};
          const freshSymbols = new Set();
          for (const rawQuote of payload.quotes || []) {
            const symbol = typeof rawQuote?.symbol === "string" ? rawQuote.symbol.trim().toUpperCase() : "";
            if (!enabledSymbols.has(symbol)) continue;
            const timestamp = quoteTimestampMs(rawQuote.timestamp);
            const accepted = applyQuote({
              ...rawQuote,
              symbol,
              bid: normalizeQuotePrice(rawQuote.bid),
              ask: normalizeQuotePrice(rawQuote.ask),
              mid: normalizeQuotePrice(rawQuote.mid),
              stale: !streamReady || rawQuote.stale === true,
            }, timestamp);
            if (accepted && rawQuote.stale !== true) freshSymbols.add(symbol);
          }
          for (const item of payload.errors || []) {
            const symbol = typeof item?.symbol === "string" ? item.symbol.trim().toUpperCase() : "";
            if (!enabledSymbols.has(symbol)) continue;
            nextErrors[symbol] = item;
            setQuotes((current) => current[symbol] ? {
              ...current,
              [symbol]: { ...current[symbol], bid: null, ask: null, mid: null, stale: true },
            } : current);
          }
          setQuoteErrors(nextErrors);
          setQuoteRefresh(streamReady ? "ready" : "error");
          return { errors: new Set(Object.keys(nextErrors)), freshSymbols };
        } catch (error) {
          if (disposed) return null;
          setQuoteErrors(Object.fromEntries(symbols.map(({ symbol }) => [symbol, {
            symbol,
            code: "request_failed",
            message: error.message,
          }])));
          setQuoteRefresh("error");
          return null;
        } finally {
          snapshotPromise = null;
        }
      })();
      return snapshotPromise;
    };

    const markSnapshotFresh = (snapshot) => {
      if (!snapshot) return;
      setQuotes((current) => Object.fromEntries(Object.entries(current).map(([symbol, quote]) => [
        symbol,
        snapshot.freshSymbols.has(symbol) && !snapshot.errors.has(symbol) ? { ...quote, stale: false } : quote,
      ])));
    };

    const refreshSnapshotForConnection = async () => {
      if (snapshotPromise) await snapshotPromise;
      return refreshSnapshot();
    };

    const scheduleRetry = () => {
      if (disposed || document.hidden || retryTimer !== null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void startConnection();
      }, QUOTE_FALLBACK_MS);
    };

    const subscribeAndSync = async () => {
      const snapshotErrors = await refreshSnapshotForConnection();
      if (disposed || document.hidden || connection.state !== signalR.HubConnectionState.Connected) return;
      await connection.invoke("Subscribe", providerSymbols);
      if (disposed || document.hidden) return;
      streamReady = true;
      markSnapshotFresh(snapshotErrors);
      setQuoteRefresh("ready");
    };

    const startConnection = async () => {
      if (disposed || document.hidden || starting || !connection
        || connection.state !== signalR.HubConnectionState.Disconnected) return;
      starting = true;
      setQuoteRefresh((current) => current === "loading" ? "loading" : "refreshing");
      try {
        await connection.start();
        await subscribeAndSync();
      } catch {
        markQuotesStale();
        if (connection.state !== signalR.HubConnectionState.Disconnected) await connection.stop();
        scheduleRetry();
      } finally {
        starting = false;
        if (!disposed && !document.hidden && connection?.state === signalR.HubConnectionState.Disconnected) {
          scheduleRetry();
        }
      }
    };

    if (providerSymbols.length) {
      connection = new signalR.HubConnectionBuilder()
        .withUrl("https://biquote.io/hubs/tick", { withCredentials: false })
        .withAutomaticReconnect()
        .configureLogging(signalR.LogLevel.Error)
        .build();
      connection.on("ReceiveTick", (rawTick) => {
        if (disposed || !rawTick || typeof rawTick !== "object") return;
        const providerSymbol = typeof rawTick.symbol === "string" ? rawTick.symbol.trim().toUpperCase() : "";
        const mappedSymbols = canonicalSymbolsByProviderSymbol.get(providerSymbol);
        const timestamp = quoteTimestampMs(rawTick.timestamp);
        if (!mappedSymbols?.length || timestamp === null) return;
        const bid = normalizeQuotePrice(rawTick.bid);
        const ask = normalizeQuotePrice(rawTick.ask);
        const mid = normalizeQuotePrice(rawTick.mid);
        if ((rawTick.bid != null && bid === null) || (rawTick.ask != null && ask === null) || mid === null) return;
        const marketState = typeof rawTick.marketState === "string" ? rawTick.marketState : null;
        const receivedAt = Date.now();
        const isStale = rawTick.stale === true ||
          marketState?.toLowerCase() === "closed" ||
          timestamp > receivedAt + 60_000 ||
          receivedAt - timestamp > LIVE_TICK_MAX_AGE_MS;
        if (isStale) {
          setQuotes((current) => {
            const next = { ...current };
            for (const symbol of mappedSymbols) {
              const previousTimestamp = quoteTimes.current[symbol];
              if (previousTimestamp !== undefined && timestamp <= previousTimestamp) continue;
              next[symbol] = {
                symbol,
                bid,
                ask,
                mid,
                timestamp: rawTick.timestamp ?? null,
                stale: true,
                ...(marketState ? { market_state: marketState } : {}),
              };
            }
            return next;
          });
          return;
        }
        flushSync(() => {
          let accepted = false;
          for (const symbol of mappedSymbols) {
            const previousTimestamp = quoteTimes.current[symbol];
            if (previousTimestamp !== undefined && timestamp < previousTimestamp) continue;
            const tick = {
              symbol,
              bid,
              ask,
              mid,
              timestamp: rawTick.timestamp ?? null,
              timestampMs: timestamp,
              stale: false,
              ...(marketState ? { market_state: marketState } : {}),
            };
            if (!applyQuote(tick, timestamp, true)) continue;
            accepted = true;
            onAcceptedTick?.(tick);
            liveTickHandler.current?.(tick);
            setQuoteErrors((current) => {
              if (!current[symbol]) return current;
              const next = { ...current };
              delete next[symbol];
              return next;
            });
          }
          if (accepted) setQuoteRefresh("ready");
        });
      });
      connection.onreconnecting(markQuotesStale);
      connection.onreconnected(() => {
        streamReady = false;
        void subscribeAndSync().catch(() => {
          markQuotesStale();
          void connection.stop();
        });
      });
      connection.onclose(() => {
        markQuotesStale();
        scheduleRetry();
      });
      void startConnection();
    }

    const fallbackTimer = window.setInterval(() => {
      if (!streamReady) void refreshSnapshot();
    }, QUOTE_FALLBACK_MS);
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (retryTimer !== null) {
          window.clearTimeout(retryTimer);
          retryTimer = null;
        }
        markQuotesStale();
        if (connection && connection.state !== signalR.HubConnectionState.Disconnected) void connection.stop();
      } else {
        void startConnection();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      window.clearInterval(fallbackTimer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (connection) void connection.stop();
    };
  }, [symbols, onAcceptedTick]);

  return { symbols, symbolState, symbolError, quotes, quoteErrors, quoteRefresh };
}

function useCandles(symbol, interval) {
  const [candles, setCandles] = useState([]);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [source, setSource] = useState("");
  const [dataKey, setDataKey] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const pagerRef = useRef(null);
  const loadingMoreRef = useRef(false);
  const requestKey = `${symbol}|${interval}`;

  const loadOlderHistory = useCallback(async () => {
    const pager = pagerRef.current;
    if (!pager || !pager.hasMore || loadingMoreRef.current) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await pager.loadOlder();
      if (pagerRef.current !== pager) return;
      if (result.added > 0) setCandles(result.candles);
      setHasMoreHistory(result.hasMore);
      setError("");
    } catch (requestError) {
      if (requestError.name === "AbortError" || pagerRef.current !== pager) return;
      setError(requestError.message);
    } finally {
      if (pagerRef.current === pager) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    setCandles([]);
    setDataKey(requestKey);
    setState("loading");
    setError("");
    setSource("");
    setLoadingMore(false);
    setHasMoreHistory(false);
    loadingMoreRef.current = false;
    if (!symbol) {
      pagerRef.current = null;
      setState("empty");
      return undefined;
    }
    const controller = new AbortController();
    let initialPageLoaded = false;
    const fetchPage = async ({ symbol: requestedSymbol, interval: requestedInterval, limit, to, signal }) => {
      const params = new URLSearchParams({
        symbol: requestedSymbol,
        interval: requestedInterval,
        limit: String(limit),
      });
      if (to) params.set("to", to);
      const payload = await getJson(`/market/candles?${params}`, signal);
      if (!Array.isArray(payload.bars)) {
        throw new Error("The market service returned malformed candle data.");
      }
      return payload.bars;
    };
    const pager = createCandleHistoryPager({
      symbol,
      interval,
      signal: controller.signal,
      fetchPage,
    });
    pagerRef.current = pager;
    pager.loadInitial().then((result) => {
      if (controller.signal.aborted || pagerRef.current !== pager) return;
      initialPageLoaded = true;
      setCandles(result.candles);
      setSource("provider_historical");
      setState(result.candles.length ? "ready" : "empty");
      setHasMoreHistory(result.hasMore);
    }).catch((requestError) => {
      if (
        requestError.name === "AbortError" ||
        controller.signal.aborted ||
        pagerRef.current !== pager
      ) return;
      setError(requestError.message);
      setState(initialPageLoaded ? "ready" : "error");
    });
    return () => {
      controller.abort();
      if (pagerRef.current === pager) pagerRef.current = null;
    };
  }, [symbol, interval]);

  return {
    candles,
    state,
    error,
    source,
    dataKey,
    loadingMore,
    hasMoreHistory,
    loadOlderHistory,
  };
}

function BrandMark() {
  return (
    <div className="brand-lockup" aria-label="Daily Funded">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M7 18V7.5c0-.8.7-1.5 1.5-1.5H18" />
          <path d="M9 15.5 12 12l2.2 1.8L18 9" />
          <path d="M15 9h3v3" />
        </svg>
      </span>
      <span className="brand-name">Daily <span>Funded</span></span>
    </div>
  );
}

function InstrumentMark({ symbol }) {
  const mark = INSTRUMENT_MARKS[symbol] || { kind: "default", glyph: symbol?.slice(0, 2) || "--", label: symbol || "Unknown instrument" };
  return (
    <span className={`instrument-mark instrument-mark-${mark.kind} instrument-mark-${symbol?.toLowerCase() || "default"}`} role="img" aria-label={mark.label}>
      {mark.kind === "pair" && mark.flags.map((flag, index) => <span key={flag} className={`fi fi-${flag} pair-flag pair-flag-${index + 1}`} aria-hidden="true" />)}
      {mark.kind === "regional-index" && <><span className={`fi fi-${mark.flag} regional-flag`} aria-hidden="true" /><span className="index-mark" aria-hidden="true">▥</span></>}
      {mark.kind === "energy" && <><span className={`fi fi-${mark.flag} energy-flag`} aria-hidden="true" /><span className="energy-glyph" aria-hidden="true">{mark.glyph}</span></>}
      {mark.kind === "bitcoin" && <span className="bitcoin-glyph" aria-hidden="true">₿</span>}
      {mark.kind === "ethereum" && <svg className="ethereum-glyph" viewBox="0 0 32 40" aria-hidden="true"><path d="M16 1 2 21l14 8 14-8L16 1Z" /><path d="m2 24 14 15 14-15-14 8-14-8Z" /></svg>}
      {mark.kind === "oil-drop" && <svg className="oil-glyph" viewBox="0 0 32 40" aria-hidden="true"><path d="M16 1C13 8 4 17 4 25a12 12 0 0 0 24 0C28 17 19 8 16 1Z" /><path className="oil-highlight" d="M10 25c0-3 2-6 4-9" /></svg>}
      {mark.kind === "gas-flame" && <svg className="gas-glyph" viewBox="0 0 32 40" aria-hidden="true"><path d="M18 1c2 8-3 9-2 15 2-2 4-4 5-7 7 7 10 13 8 20a13 13 0 0 1-26-2C2 18 12 13 18 1Z" /><path className="gas-core" d="M17 20c1 4-2 5-2 8 0 2 1 4 3 4s4-2 4-5c0-2-2-5-5-7Z" /></svg>}
      {mark.kind === "quoted-metal" && <><span className={`fi fi-${mark.flag} quote-flag`} aria-hidden="true" /><svg className="silver-bars" viewBox="0 0 36 28" aria-hidden="true"><path d="m3 9 8-5 9 5-8 5-9-5Z" /><path d="m14 9 8-5 9 5-8 5-9-5Z" /><path d="m2 17 9-5 9 5-9 5-9-5Z" /><path d="m14 17 9-5 9 5-9 5-9-5Z" /></svg></>}
      {mark.kind === "quoted-gold" && <><span className={`fi fi-${mark.flag} quote-flag`} aria-hidden="true" /><svg className="gold-bars" viewBox="0 0 36 28" aria-hidden="true"><path d="m4 8 9-5 10 4-8 6-11-5Z" /><path d="m17 12 8-5 8 4-8 5-8-4Z" /><path d="m2 17 9-5 11 5-10 6-10-6Z" /></svg></>}
      {mark.kind === "quoted-copper" && <><span className={`fi fi-${mark.flag} quote-flag`} aria-hidden="true" /><svg className="copper-bars" viewBox="0 0 36 28" aria-hidden="true"><path d="m4 8 9-5 10 4-8 6-11-5Z" /><path d="m17 12 8-5 8 4-8 5-8-4Z" /><path d="m2 17 9-5 11 5-10 6-10-6Z" /></svg></>}
      {(mark.kind === "metal" || mark.kind === "default") && <span className="mark-glyph" aria-hidden="true">{mark.glyph}</span>}
    </span>
  );
}

function QuoteChip({ label, value, tone = "neutral" }) {
  return (
    <div className={`quote-chip quote-chip-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TopBar({
  symbol,
  selected,
  quote,
  quoteError,
  watchOpen,
  onToggleWatch,
  onToggleOrder,
  account,
  equity,
  freeMargin,
  openPnl,
  accounts,
  accountsLoading,
  selectedAccountId,
  onAccountChange,
  authStatus,
  accountStatus,
  selectedAccount,
}) {
  const digits = getPriceDigits(symbol);
  const spread = quote?.bid != null && quote?.ask != null
    ? Number(quote.ask) - Number(quote.bid)
    : null;
  const marketState = getMarketState(quote, quoteError);
  const formatAccountPhase = (phase) => {
    if (typeof phase !== "string") return "";
    if (phase.toLowerCase() === "instant") return "Instant";
    const match = /^phase[_ -]?(\d+)$/i.exec(phase);
    return match ? `Phase ${match[1]}` : "";
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-button mobile-only" type="button" aria-label={watchOpen ? "Close watchlist" : "Open watchlist"} onClick={onToggleWatch}>
          {watchOpen ? <X size={19} /> : <Menu size={19} />}
        </button>
        <BrandMark />
        <label className="account-select">
          <span className="account-avatar">DF</span>
          <span className="account-select-copy">
            <small>TRADING ACCOUNT</small>
            <select
              className="account-select-dropdown"
              aria-label="Trading account"
              value={selectedAccountId}
              onChange={(event) => onAccountChange(event.target.value)}
              disabled={accountsLoading || !accounts.length}
            >
              {accounts.length
                ? accounts.map((item) => {
                  const phase = formatAccountPhase(item.phase);
                  return (
                    <option key={item.id} value={item.id}>
                      {`$${Number(item.size || 0).toLocaleString("en-US")} · ${item.label || item.plan || "Challenge"}${phase ? ` · ${phase}` : ""} · ${(item.status || "unknown").toUpperCase()} · ${item.status === "active" && item.tradingEnabled === true ? "Trading enabled" : "Trading disabled"}`}
                    </option>
                  );
                })
                : <option value="">{accountsLoading ? "Loading accounts…" : authStatus === "signed-out" ? "Sign in required" : "No account available"}</option>}
            </select>
            <small className={`account-status account-status-${(accountStatus || "unavailable").toLowerCase()}`}>
              {accountStatus
                ? `${accountStatus.toUpperCase()} · ${selectedAccount?.status === "active" && selectedAccount?.tradingEnabled === true ? "Trading enabled" : "Trading disabled"}`
                : accountsLoading ? "Loading" : "Unavailable"}
            </small>
          </span>
          <ChevronDown size={14} />
        </label>
      </div>

      <div className="topbar-market">
        <div className="market-selected">
          <InstrumentMark symbol={symbol} />
          <div><strong>{symbol || "Select market"}</strong><small>{selected ? (SHORT_NAMES[symbol] || selected.display_name || symbol) : "Market data"}</small></div>
          <span className={`state-dot state-${marketState.tone}`} title={marketState.label} />
        </div>
        <QuoteChip label="BID" value={quote?.bid == null ? "--" : formatPrice(quote.bid, digits)} tone="sell" />
        <QuoteChip label="ASK" value={quote?.ask == null ? "--" : formatPrice(quote.ask, digits)} tone="buy" />
        <QuoteChip label="SPREAD" value={spread == null ? "--" : formatPrice(spread, digits)} />
      </div>

      <div className="topbar-right">
        <div className="account-metric"><span>Balance</span><strong>{formatMoney(account?.balance)}</strong></div>
        <div className="account-metric"><span>Equity</span><strong>{formatMoney(equity)}</strong></div>
        <div className="account-metric account-metric-wide"><span>Free margin</span><strong>{formatMoney(freeMargin)}</strong></div>
        <div className="account-metric account-metric-wide"><span>Open P/L</span><strong>{formatMoney(openPnl)}</strong></div>
        <span className="topbar-divider" />
        <button className="icon-button settings-button" type="button" title="Terminal settings" aria-label="Terminal settings"><Settings2 size={18} /></button>
        <button className="mobile-order-trigger" type="button" onClick={onToggleOrder}>Order</button>
      </div>
    </header>
  );
}

function formatMoney(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
  return `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function InstrumentRow({ item, quote, error, selected, favorite, onSelect, onFavorite }) {
  const marketState = getMarketState(quote, error);
  const digits = getPriceDigits(item.symbol);
  const quoteText = priceForWatchlist(quote, digits);

  return (
    <div className={`instrument-row ${selected ? "instrument-row-selected" : ""}`}>
      <button className="instrument-main" type="button" onClick={() => onSelect(item.symbol)} aria-pressed={selected}>
        <InstrumentMark symbol={item.symbol} />
        <span className="instrument-name"><strong>{item.symbol}</strong><small>{SHORT_NAMES[item.symbol] || item.display_name || item.symbol}</small></span>
        <span className="instrument-quote"><strong>{quoteText}</strong><small className={`market-state state-text-${marketState.tone}`}>{marketState.label}</small></span>
      </button>
      <button className={`favorite-button ${favorite ? "is-favorite" : ""}`} type="button" aria-label={favorite ? `Remove ${item.symbol} from favorites` : `Add ${item.symbol} to favorites`} aria-pressed={favorite} onClick={() => onFavorite(item.symbol)}>
        <Star size={14} fill={favorite ? "currentColor" : "none"} />
      </button>
    </div>
  );
}

function Watchlist({
  symbols,
  quotes,
  quoteErrors,
  selectedSymbol,
  favorites,
  onSelect,
  onFavorite,
  loading,
  error,
  collapsed,
  onToggleCollapse,
  drawingToolbarProps,
  open,
  onClose,
}) {
  const [search, setSearch] = useState("");
  const searchValue = search.trim().toLowerCase();
  const visible = symbols.filter((item) => {
    const name = SHORT_NAMES[item.symbol] || item.display_name || "";
    return !searchValue || `${item.symbol} ${name}`.toLowerCase().includes(searchValue);
  });
  const favoriteRows = visible.filter((item) => favorites.includes(item.symbol));

  return (
    <>
      <button className={`drawer-scrim ${open ? "scrim-visible" : ""}`} type="button" aria-label="Close watchlist" onClick={onClose} />
      <aside className={`watchlist-panel ${open ? "watchlist-open" : ""} ${collapsed ? "watchlist-collapsed" : ""}`}>
        <div className="panel-heading watchlist-heading">
          {!collapsed && <div><span className="eyebrow">MARKETS</span><h2>Watchlist <span className="count-pill">{symbols.length}</span></h2></div>}
          <button className="icon-button mobile-only" type="button" aria-label="Close watchlist" onClick={onClose}><X size={18} /></button>
          <button className="collapse-button desktop-only" type="button" title={collapsed ? "Expand watchlist" : "Collapse watchlist"} aria-label={collapsed ? "Expand watchlist" : "Collapse watchlist"} onClick={onToggleCollapse}>{collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}</button>
        </div>
        {collapsed && <DrawingToolbar {...drawingToolbarProps} />}
        <label className="search-field">
          <Search size={15} />
          <input type="search" placeholder="Search markets" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search markets" />
          <kbd>/</kbd>
        </label>
        <div className="watchlist-columns"><span>INSTRUMENT</span><span>BID / ASK · STATE</span></div>
        <div className="watchlist-scroll">
          {loading && <div className="watchlist-message"><span className="loader-dot" />Loading markets…</div>}
          {error && <div className="watchlist-error"><strong>Markets unavailable</strong><span>{error}</span></div>}
          {!loading && !error && symbols.length === 0 && <div className="watchlist-message">No market data symbols returned.</div>}
          {!loading && !error && (
            <>
              {favoriteRows.length > 0 && (
                <WatchlistSection label="Favorites" items={favoriteRows} quotes={quotes} errors={quoteErrors} selectedSymbol={selectedSymbol} favorites={favorites} onSelect={onSelect} onFavorite={onFavorite} />
              )}
              {CATEGORY_SECTIONS.map(({ key, label }) => {
                const items = visible.filter((item) => item.category?.toUpperCase() === key && !favorites.includes(item.symbol));
                if (!items.length) return null;
                return <WatchlistSection key={key} label={label} items={items} quotes={quotes} errors={quoteErrors} selectedSymbol={selectedSymbol} favorites={favorites} onSelect={onSelect} onFavorite={onFavorite} />;
              })}
              {visible.length === 0 && <div className="watchlist-message">No markets match “{search}”.</div>}
            </>
          )}
        </div>
        <div className="watchlist-foot"><span className="live-led" />Prices from Daily Funded market data</div>
      </aside>
    </>
  );
}

function WatchlistSection({ label, items, quotes, errors, selectedSymbol, favorites, onSelect, onFavorite }) {
  return (
    <section className="watchlist-section">
      <div className="section-label"><span>{label}</span><span>{items.length}</span></div>
      {items.map((item) => <InstrumentRow key={item.symbol} item={item} quote={quotes[item.symbol]} error={errors[item.symbol]} selected={selectedSymbol === item.symbol} favorite={favorites.includes(item.symbol)} onSelect={onSelect} onFavorite={onFavorite} />)}
    </section>
  );
}

function ChartView({
  symbol,
  selected,
  quote,
  quoteError,
  candles,
  candleDataKey,
  state,
  error,
  loadingMore,
  hasMoreHistory,
  loadOlderHistory,
  interval,
  onIntervalChange,
  onOpenWatchlist,
  selectedDrawingTool,
  drawings,
  setDrawingsBySymbol,
  onCreateDrawing,
  onSelectDrawingTool,
  drawingToolbarProps,
  onRemoveDrawing,
  magnetMode,
  drawingsVisible,
  positionsVisible,
  liveTickHandler,
  positions,
  canTrade,
  onClosePosition,
  onModifyPosition,
}) {
  const chartHost = useRef(null);
  const chartRef = useRef(null);
  const candleSeries = useRef(null);
  const candleDataRef = useRef([]);
  const liveCandlesRef = useRef(new Map());
  const positionPriceLines = useRef(new Map());
  const pendingLiveTicks = useRef([]);
  const candleKeyRef = useRef("");
  const baselineKeyRef = useRef("");
  const initialHistoryFitKeyRef = useRef("");
  const applyingHistoryRef = useRef(false);
  const applyLiveTickRef = useRef(null);
  const dragRef = useRef(null);
  const [hasLiveCandle, setHasLiveCandle] = useState(false);
  const [candleCount, setCandleCount] = useState(0);
  const [candleBucketTime, setCandleBucketTime] = useState(null);
  const [latestTickTimestampMs, setLatestTickTimestampMs] = useState(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [chartTimeZone, setChartTimeZone] = useState(getInitialChartTimeZone);
  const [pendingDrawingPoints, setPendingDrawingPoints] = useState([]);
  const [drawingCursor, setDrawingCursor] = useState(null);
  const [draftPrices, setDraftPrices] = useState(new Map());
  const [closingIds, setClosingIds] = useState(new Set());
  const [modifyingIds, setModifyingIds] = useState(new Set());
  const [controlError, setControlError] = useState("");
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [chartControlsVisible, setChartControlsVisible] = useState(false);
  const [selectedDrawingId, setSelectedDrawingId] = useState(null);
  const [drawingContextMenu, setDrawingContextMenu] = useState(null);
  const drawingDragRef = useRef(null);
  const chartControlsHideTimer = useRef(null);
  const chartTimeZoneRef = useRef(getResolvedTimeZone(chartTimeZone, symbol));
  chartTimeZoneRef.current = getResolvedTimeZone(chartTimeZone, symbol);
  const digits = getPriceDigits(symbol);
  const selectedDrawingToolbarStyle = useMemo(() => {
    if (!selectedDrawingId || !chartHost.current || !chartRef.current || !candleSeries.current) return { left: 16, top: 16 };
    const selectedDrawingData = drawings.find((drawing) => drawing.id === selectedDrawingId);
    if (!selectedDrawingData) return { left: 16, top: 16 };
    const timeScale = chartRef.current.timeScale();
    const points = selectedDrawingData.points
      .map((point) => ({
        x: timeScale.timeToCoordinate(point.time),
        y: candleSeries.current.priceToCoordinate(point.price),
      }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!points.length) return { left: 16, top: 16 };
    const xAvg = points.reduce((total, point) => total + point.x, 0) / points.length;
    const yAvg = points.reduce((total, point) => total + point.y, 0) / points.length;
    const width = chartHost.current.clientWidth || 0;
    const height = chartHost.current.clientHeight || 0;
    return {
      left: `${Math.min(Math.max(xAvg + 18, 16), Math.max(16, width - 260))}px`,
      top: `${Math.min(Math.max(yAvg - 42, 16), Math.max(16, height - 155))}px`,
    };
  }, [chartHost, drawings, layoutVersion, selectedDrawingId]);

  const handleChartControl = useCallback((action) => {
    const timeScale = chartRef.current?.timeScale?.();
    if (!timeScale) return;

    const range = timeScale.getVisibleLogicalRange?.();
    if (!range) {
      if (action === "reset") timeScale.fitContent();
      return;
    }

    const currentSpan = Math.max(2, range.to - range.from);
    const moveStep = Math.max(2, currentSpan * 0.18);
    const setRange = (from, span = currentSpan) => {
      const rangeFrom = Math.max(0, from);
      timeScale.setVisibleLogicalRange({ from: rangeFrom, to: rangeFrom + span });
    };

    if (action === "zoom-in") {
      const nextSpan = Math.max(2, currentSpan * 0.8);
      setRange((range.from + range.to - nextSpan) / 2, nextSpan);
    } else if (action === "zoom-out") {
      const dataCount = candleDataRef.current.length;
      const nextSpan = Math.min(
        currentSpan * 1.2,
        Math.max(currentSpan, dataCount * 1.5),
      );
      setRange((range.from + range.to - nextSpan) / 2, nextSpan);
    } else if (action === "prev") {
      setRange(range.from - moveStep);
    } else if (action === "next") {
      setRange(range.from + moveStep);
    } else if (action === "reset") {
      timeScale.fitContent();
    }
  }, []);
  const dataKey = `${symbol}|${interval}`;

  useLayoutEffect(() => {
    if (!chartHost.current) return undefined;
    const chart = createChart(chartHost.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#141b1f" },
        textColor: "#828c8c",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#303a3f" },
        horzLines: { color: "#303a3f" },
      },
      rightPriceScale: { borderColor: "#303737", minimumWidth: 72, autoScale: true },
      timeScale: {
        borderColor: "#303737",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        barSpacing: 9,
        tickMarkFormatter: (time, tickMarkType) => formatChartTime(time, chartTimeZoneRef.current, tickMarkType),
      },
      crosshair: { vertLine: { color: "#758280", labelBackgroundColor: "#2e3735" }, horzLine: { color: "#758280", labelBackgroundColor: "#2e3735" } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      localization: {
        priceFormatter: (price) => formatPrice(price, digits),
        timeFormatter: (time) => formatChartCrosshairTime(time, chartTimeZoneRef.current),
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#1685f5",
      downColor: "#f0443e",
      borderUpColor: "#1685f5",
      borderDownColor: "#f0443e",
      wickUpColor: "#1685f5",
      wickDownColor: "#f0443e",
      borderVisible: true,
      wickVisible: true,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chartRef.current = chart;
    candleSeries.current = series;
    const updateOverlayLayout = () => setLayoutVersion((version) => version + 1);
    chart.subscribeCrosshairMove(updateOverlayLayout);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updateOverlayLayout);
    if (chartHost.current) resizeObserver?.observe(chartHost.current);
    return () => {
      resizeObserver?.disconnect();
      chart.unsubscribeCrosshairMove(updateOverlayLayout);
      for (const { line } of positionPriceLines.current.values()) {
        series.removePriceLine(line);
      }
      positionPriceLines.current.clear();
      chart.remove();
      chartRef.current = null;
      candleSeries.current = null;
    };
  }, []);

  useEffect(() => {
    const resolvedTimeZone = getResolvedTimeZone(chartTimeZone, symbol);
    chartTimeZoneRef.current = resolvedTimeZone;
    chartRef.current?.applyOptions({
      timeScale: {
        tickMarkFormatter: (time, tickMarkType) => formatChartTime(time, resolvedTimeZone, tickMarkType),
      },
      localization: {
        timeFormatter: (time) => formatChartCrosshairTime(time, resolvedTimeZone),
      },
    });
    try {
      localStorage.setItem("df-terminal-chart-timezone", chartTimeZone);
    } catch (error) {
      console.warn("Unable to save the chart time zone preference.", error);
    }
  }, [chartTimeZone, symbol]);

  useEffect(() => {
    setPendingDrawingPoints([]);
    setDrawingCursor(null);
    setDrawingContextMenu(null);
    setSelectedDrawingId((current) => drawings.some((drawing) => drawing.id === current) ? current : null);
  }, [selectedDrawingTool, symbol, drawings]);

  useLayoutEffect(() => {
    if (candleKeyRef.current === dataKey) return;
    candleKeyRef.current = dataKey;
    baselineKeyRef.current = "";
    initialHistoryFitKeyRef.current = "";
    candleDataRef.current = [];
    liveCandlesRef.current = new Map();
    pendingLiveTicks.current = [];
    setCandleBucketTime(null);
    setLatestTickTimestampMs(null);
    setDraftPrices(new Map());
    setHasLiveCandle(false);
    setCandleCount(0);
    candleSeries.current?.setData([]);
  }, [dataKey]);

  useLayoutEffect(() => {
    const series = candleSeries.current;
    if (!series) return undefined;
    const intervalSeconds = INTERVAL_SECONDS[interval];
    const applyTick = (tick) => {
      if (tick.symbol !== symbol) return true;
      if (!Number.isFinite(tick.timestampMs) || tick.mid == null) return false;
      if (baselineKeyRef.current !== dataKey) {
        pendingLiveTicks.current.push(tick);
        return true;
      }
      const current = candleDataRef.current;
      const last = current[current.length - 1];
      const next = candleFromLiveTick(last, tick, intervalSeconds);
      if (!next) return false;
      const candleTime = next.time;
      liveCandlesRef.current.set(candleTime, next);
      setCandleBucketTime(candleTime);
      setLatestTickTimestampMs(tick.timestampMs);

      series.update(next);
      if (last && candleTime === last.time) current[current.length - 1] = next;
      else {
        current.push(next);
        setCandleCount((count) => count + 1);
      }
      setHasLiveCandle(true);
      return true;
    };

    applyLiveTickRef.current = applyTick;
    liveTickHandler.current = applyTick;
    return () => {
      if (liveTickHandler.current === applyTick) liveTickHandler.current = null;
      if (applyLiveTickRef.current === applyTick) applyLiveTickRef.current = null;
    };
  }, [dataKey, interval, liveTickHandler, symbol]);

  useLayoutEffect(() => {
    const series = candleSeries.current;
    if (!series || state === "loading" || candleDataKey !== dataKey) return;
    const sameBaseline = baselineKeyRef.current === dataKey;
    const timeScale = chartRef.current?.timeScale();
    const mergedCandles = mergeHistoryWithLive(candles, liveCandlesRef.current);
    series.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: 10 ** -digits } });
    applyingHistoryRef.current = true;
    try {
      setSeriesDataPreservingVisibleRange(series, timeScale, mergedCandles, sameBaseline);
    } finally {
      applyingHistoryRef.current = false;
    }
    candleDataRef.current = mergedCandles;
    setCandleCount(mergedCandles.length);
    baselineKeyRef.current = dataKey;
    const queuedTicks = pendingLiveTicks.current;
    pendingLiveTicks.current = [];
    for (const tick of queuedTicks) applyLiveTickRef.current?.(tick);
    fitInitialHistoryOnce(timeScale, dataKey, loadingMore, initialHistoryFitKeyRef, mergedCandles.length);
  }, [candles, candleDataKey, dataKey, digits, loadingMore, state]);

  useEffect(() => {
    if (!hasMoreHistory || state !== "ready" || candleDataKey !== dataKey) return undefined;
    const timeScale = chartRef.current?.timeScale();
    if (!timeScale) return undefined;
    const checkLeftEdge = (logicalRange) => {
      if (!applyingHistoryRef.current && shouldLoadOlderHistory(logicalRange)) {
        void loadOlderHistory();
      }
    };
    timeScale.subscribeVisibleLogicalRangeChange(checkLeftEdge);
    checkLeftEdge(timeScale.getVisibleLogicalRange());
    return () => timeScale.unsubscribeVisibleLogicalRangeChange(checkLeftEdge);
  }, [candles, candleDataKey, dataKey, hasMoreHistory, loadOlderHistory, state]);

  useLayoutEffect(() => {
    const series = candleSeries.current;
    if (!series) return;
    series.applyOptions({ priceLineVisible: false, lastValueVisible: false });
    if (quote?.mid != null && Number.isFinite(Number(quote.mid))) {
      const line = series.createPriceLine({
        price: Number(quote.mid),
        color: quote.stale ? "#a5a88f" : "#ee4f4f",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
      });
      return () => series.removePriceLine(line);
    }
    return undefined;
  }, [quote?.mid, quote?.stale]);

  useLayoutEffect(() => {
    const series = candleSeries.current;
    if (!series) return;
    const desiredLines = new Map();
    for (const position of positions) {
      if (
        !positionsVisible ||
        position?.status !== "open" ||
        position.symbol?.toUpperCase() !== symbol ||
        typeof position.id !== "string"
      ) continue;
      const entryPrice = Number(position.open_price);
      if (Number.isFinite(entryPrice) && entryPrice > 0) {
        desiredLines.set(`${position.id}:entry`, {
          price: entryPrice,
          color: position.side === "BUY" ? "#62c99d" : "#ef8279",
          lineStyle: 0,
        });
      }
      for (const [field, color, title] of [
        ["stop_loss", "#e17f73", "SL"],
        ["take_profit", "#6fc6a1", "TP"],
      ]) {
        const price = Number(draftPrices.get(`${position.id}:${field}`) ?? position[field]);
        if (Number.isFinite(price) && price > 0) {
          desiredLines.set(`${position.id}:${field}`, {
            price,
            color,
            lineStyle: 2,
            title,
          });
        }
      }
    }

    for (const [key, existing] of positionPriceLines.current) {
      if (!desiredLines.has(key)) {
        series.removePriceLine(existing.line);
        positionPriceLines.current.delete(key);
      }
    }
    for (const [key, options] of desiredLines) {
      const existing = positionPriceLines.current.get(key);
      if (!existing) {
        positionPriceLines.current.set(key, {
          line: series.createPriceLine({
            price: options.price,
            color: options.color,
            lineWidth: 1,
            lineStyle: options.lineStyle,
            axisLabelVisible: true,
            title: options.title,
          }),
          price: options.price,
        });
      } else if (existing.price !== options.price) {
        existing.line.applyOptions({ price: options.price });
        existing.price = options.price;
      }
    }
  }, [draftPrices, positions, positionsVisible, symbol]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const zoomIn = () => handleChartControl("zoom-in");
    window.addEventListener("df-chart-zoom-in", zoomIn);
    return () => window.removeEventListener("df-chart-zoom-in", zoomIn);
  }, [handleChartControl]);

  useEffect(() => {
    const container = chartHost.current?.parentElement;
    if (!container) return undefined;

    const handlePointerMove = (event) => {
      const bounds = container.getBoundingClientRect();
      const isNearBottom = event.clientY >= bounds.bottom - 94;
      setChartControlsVisible(isNearBottom);
      if (event.pointerType === "touch" && isNearBottom) {
        window.clearTimeout(chartControlsHideTimer.current);
        chartControlsHideTimer.current = window.setTimeout(() => {
          setChartControlsVisible(false);
        }, 4500);
      }
    };
    const handlePointerDown = (event) => {
      if (event.pointerType !== "touch") return;
      const bounds = container.getBoundingClientRect();
      if (event.clientY < bounds.bottom - 94) return;
      setChartControlsVisible(true);
      window.clearTimeout(chartControlsHideTimer.current);
      chartControlsHideTimer.current = window.setTimeout(() => {
        setChartControlsVisible(false);
      }, 4500);
    };
    const handlePointerLeave = (event) => {
      if (event.pointerType === "touch") return;
      setChartControlsVisible(false);
      window.clearTimeout(chartControlsHideTimer.current);
    };

    container.addEventListener("pointermove", handlePointerMove);
    container.addEventListener("pointerdown", handlePointerDown);
    container.addEventListener("pointerleave", handlePointerLeave);

    return () => {
      window.clearTimeout(chartControlsHideTimer.current);
      container.removeEventListener("pointermove", handlePointerMove);
      container.removeEventListener("pointerdown", handlePointerDown);
      container.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, []);

  const tickAgeMs = latestTickTimestampMs === null ? Infinity : clockNow - latestTickTimestampMs;
  const countdownLive = Boolean(
    candleBucketTime !== null &&
    quote &&
    quote.stale !== true &&
    tickAgeMs >= 0 &&
    tickAgeMs <= QUOTE_FALLBACK_MS
  );
  const intervalSeconds = INTERVAL_SECONDS[interval];
  const currentCandleStart = Math.floor(clockNow / (intervalSeconds * 1000)) * intervalSeconds;
  const candleEndMs = (currentCandleStart + intervalSeconds) * 1000;
  const remainingSeconds = Math.max(0, Math.ceil((candleEndMs - clockNow) / 1000));
  const countdownText = remainingSeconds >= 3600
      ? `${String(Math.floor(remainingSeconds / 3600)).padStart(2, "0")}:${String(Math.floor((remainingSeconds % 3600) / 60)).padStart(2, "0")}:${String(remainingSeconds % 60).padStart(2, "0")}`
      : `${String(Math.floor(remainingSeconds / 60)).padStart(2, "0")}:${String(remainingSeconds % 60).padStart(2, "0")}`;

  async function closeChartPosition(position) {
    if (closingIds.has(position.id) || !canTrade) return;
    setClosingIds((current) => new Set(current).add(position.id));
    setControlError("");
    try {
      const result = await onClosePosition(position);
      if (result === false) setControlError("The server did not confirm closing this position.");
    } catch (error) {
      setControlError(error.message || "The server did not confirm closing this position.");
    } finally {
      setClosingIds((current) => {
        const next = new Set(current);
        next.delete(position.id);
        return next;
      });
    }
  }

  function priceFromPointer(event) {
    const rect = chartHost.current?.getBoundingClientRect();
    if (!rect || !candleSeries.current) return null;
    const price = candleSeries.current.coordinateToPrice(event.clientY - rect.top);
    if (price === null || price === undefined || !Number.isFinite(Number(price))) return null;
    return Number(price);
  }

  function chartPointFromPointer(event) {
    const rect = chartHost.current?.getBoundingClientRect();
    const timeScale = chartRef.current?.timeScale?.();
    if (!rect || !timeScale || !candleSeries.current) return null;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || x > rect.width - 72 || y < 0 || y > rect.height - 28) return null;
    let time = timeScale.coordinateToTime(x);
    let price = candleSeries.current.coordinateToPrice(y);
    if (
      time === null ||
      time === undefined ||
      price === null ||
      price === undefined ||
      !Number.isFinite(Number(price))
    ) return null;
    price = Number(price);
    if (magnetMode !== "off" && candleDataRef.current.length) {
      let nearestCandle = null;
      let nearestDistance = Infinity;
      for (const candle of candleDataRef.current) {
        const candleX = timeScale.timeToCoordinate(candle.time);
        if (!Number.isFinite(candleX)) continue;
        const distance = Math.abs(candleX - x);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestCandle = candle;
        }
      }
      const snapDistance = magnetMode === "strong" ? 28 : 14;
      const snapPriceDistance = magnetMode === "strong" ? 24 : 12;
      if (nearestCandle && nearestDistance <= snapDistance) {
        const candlePrices = [nearestCandle.open, nearestCandle.high, nearestCandle.low, nearestCandle.close];
        let nearestPrice = price;
        let nearestPriceDistance = snapPriceDistance;
        for (const candidate of candlePrices) {
          const candidateY = candleSeries.current.priceToCoordinate(candidate);
          if (!Number.isFinite(candidateY)) continue;
          const distance = Math.abs(candidateY - y);
          if (distance < nearestPriceDistance) {
            nearestPriceDistance = distance;
            nearestPrice = candidate;
          }
        }
        if (nearestPriceDistance < snapPriceDistance) {
          time = nearestCandle.time;
          price = nearestPrice;
        }
      }
    }
    return { time, price };
  }

  function getDrawingHitTest(event, candidates = drawings) {
    const point = chartPointFromPointer(event);
    const timeScale = chartRef.current?.timeScale?.();
    const series = candleSeries.current;
    if (!point || !timeScale || !series) return null;
    const click = {
      x: timeScale.timeToCoordinate(point.time),
      y: series.priceToCoordinate(point.price),
    };
    let closest = null;
    let closestDistance = 10;
    for (const drawing of [...candidates].reverse()) {
      if (drawing.hidden) continue;
      const pointCoordinates = drawing.points.map((drawingPoint) => ({
        x: timeScale.timeToCoordinate(drawingPoint.time),
        y: series.priceToCoordinate(drawingPoint.price),
      }));
      const geometry = getDrawingGeometry(
        drawing,
        pointCoordinates,
        candleDataRef.current,
        (time) => timeScale.timeToCoordinate(time),
        (price) => series.priceToCoordinate(price),
        chartHost.current?.clientWidth || 0,
        chartHost.current?.clientHeight || 0,
      );
      for (const { start, end } of geometry.lines) {
        if (![start.x, start.y, end.x, end.y, click.x, click.y].every(Number.isFinite)) continue;
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        const projection = lengthSquared ? Math.max(0, Math.min(1, ((click.x - start.x) * dx + (click.y - start.y) * dy) / lengthSquared)) : 0;
        const distance = Math.hypot(click.x - (start.x + projection * dx), click.y - (start.y + projection * dy));
        if (distance < closestDistance) {
          closestDistance = distance;
          closest = drawing;
        }
      }
      for (const coordinate of pointCoordinates) {
        if (![coordinate.x, coordinate.y].every(Number.isFinite)) continue;
        const distance = Math.hypot(click.x - coordinate.x, click.y - coordinate.y);
        if (distance < closestDistance) {
          closestDistance = distance;
          closest = drawing;
        }
      }
    }
    return closest;
  }

  function updateSelectedDrawingStyle(updates) {
    if (!selectedDrawingId) return;
    setDrawingsBySymbol((current) => ({
      ...current,
      [symbol]: (current[symbol] || []).map((drawing) => drawing.id === selectedDrawingId
        ? { ...drawing, ...updates }
        : drawing),
    }));
  }

  function duplicateSelectedDrawing() {
    if (!selectedDrawingId) return;
    const drawing = drawings.find((item) => item.id === selectedDrawingId);
    if (!drawing) return;
    const duplicate = {
      ...drawing,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      points: drawing.points.map((point) => ({ ...point })),
      hidden: false,
      locked: false,
    };
    setDrawingsBySymbol((current) => ({
      ...current,
      [symbol]: [...(current[symbol] || []), duplicate],
    }));
    setSelectedDrawingId(duplicate.id);
  }

  function startSelectionDrag(event, drawingId, pointIndex = null) {
    const drawing = drawings.find((item) => item.id === drawingId);
    if (!drawing || drawing.locked) return;
    const point = chartPointFromPointer(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedDrawingId(drawingId);
    setDrawingContextMenu(null);
    drawingDragRef.current = {
      drawingId,
      pointIndex,
      startPointer: point,
      startPoints: drawing.points.map((entry) => ({ ...entry })),
    };
    if (event.currentTarget?.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function handleDrawingPointerDown(event) {
    if (event.button !== 0 && event.button !== 2) return;
    if (!selectedDrawingTool && drawingToolbarProps.cursorMode === "eraser") {
      const hit = getDrawingHitTest(event);
      if (!hit || hit.locked) return;
      event.preventDefault();
      event.stopPropagation();
      onRemoveDrawing(symbol, hit.id);
      return;
    }
    if (!selectedDrawingTool && drawingToolbarProps.cursorMode !== "dot") {
      if (event.button === 2) {
        const hit = getDrawingHitTest(event);
        if (hit) {
          const bounds = chartHost.current?.getBoundingClientRect();
          event.preventDefault();
          event.stopPropagation();
          setSelectedDrawingId(hit.id);
          setDrawingContextMenu({
            drawingId: hit.id,
            x: event.clientX - (bounds?.left || 0),
            y: event.clientY - (bounds?.top || 0),
          });
        } else {
          setSelectedDrawingId(null);
          setDrawingContextMenu(null);
        }
        return;
      }
      const hit = getDrawingHitTest(event);
      if (hit) {
        setSelectedDrawingId(hit.id);
        setDrawingContextMenu(null);
        return;
      }
      setSelectedDrawingId(null);
      setDrawingContextMenu(null);
      return;
    }
    if (!selectedDrawingTool) return;
    const tool = DRAWING_TOOL_BY_ID.get(selectedDrawingTool);
    const point = chartPointFromPointer(event);
    if (!tool || !point) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const nextPoints = [...pendingDrawingPoints, point];
    setDrawingCursor(point);
    if (nextPoints.length >= tool.points) {
      onCreateDrawing(symbol, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        type: tool.id,
        points: nextPoints.slice(0, tool.points),
        color: "#c8eb7b",
        opacity: 1,
        width: 2,
        lineStyle: "solid",
        hidden: false,
        locked: false,
      });
      setPendingDrawingPoints([]);
      setDrawingCursor(null);
      setSelectedDrawingId(null);
      return;
    }
    setPendingDrawingPoints(nextPoints);
  }

  function handleDrawingPointerMove(event) {
    const drag = drawingDragRef.current;
    if (drag) {
      const point = chartPointFromPointer(event);
      if (!point) return;
      const timeScale = chartRef.current?.timeScale?.();
      const priceScale = candleSeries.current?.priceScale?.();
      if (!timeScale || !priceScale) return;
      const deltaTime = Number(point.time) - Number(drag.startPointer.time);
      const deltaPrice = point.price - drag.startPointer.price;
      setDrawingsBySymbol((current) => ({
        ...current,
        [symbol]: (current[symbol] || []).map((drawing) => {
          if (drawing.id !== drag.drawingId) return drawing;
          if (drag.pointIndex === null) {
            return {
              ...drawing,
              points: drawing.points.map((entry, index) => {
                const original = drag.startPoints[index];
                if (!original) return entry;
                return {
                  ...entry,
                  time: Number(original.time) + deltaTime,
                  price: Number(original.price) + deltaPrice,
                };
              }),
            };
          }
          const next = drawing.points.map((entry, index) => ({ ...entry }));
          next[drag.pointIndex] = {
            ...next[drag.pointIndex],
            time: Number(drag.startPoints[drag.pointIndex].time) + deltaTime,
            price: Number(drag.startPoints[drag.pointIndex].price) + deltaPrice,
          };
          return { ...drawing, points: next };
        }),
      }));
      return;
    }
    if (!selectedDrawingTool && drawingToolbarProps.cursorMode !== "dot") return;
    const point = chartPointFromPointer(event);
    setDrawingCursor(point);
  }

  function renderDrawing(drawing, preview = false) {
    if (!chartRef.current || !candleSeries.current) return null;
    if (drawing.hidden && !preview) return null;
    const timeScale = chartRef.current.timeScale();
    const pointCoordinates = drawing.points.map((point) => ({
      x: timeScale.timeToCoordinate(point.time),
      y: candleSeries.current.priceToCoordinate(point.price),
    }));
    const geometry = getDrawingGeometry(
      drawing,
      pointCoordinates,
      candleDataRef.current,
      (time) => timeScale.timeToCoordinate(time),
      (price) => candleSeries.current.priceToCoordinate(price),
      chartHost.current?.clientWidth || 0,
      chartHost.current?.clientHeight || 0,
    );
    if (!geometry.lines.length) return null;
    const label = DRAWING_TOOL_BY_ID.get(drawing.type)?.label || "Chart drawing";
    const stroke = preview ? "#d4ed94" : drawing.color || "#c8eb7b";
    const strokeWidth = preview ? 1.5 : Number(drawing.width) || 2;
    const dashArray = preview ? "5 4" : getDrawingLineDash(drawing.lineStyle || "solid");
    const opacity = preview ? 0.72 : Number(drawing.opacity ?? 1);
    const isSelected = !preview && selectedDrawingId === drawing.id;
    const selectionHandles = pointCoordinates.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    return (
      <g
        className={`chart-drawing chart-drawing-${drawing.type}`}
        key={drawing.id}
        opacity={opacity}
        onPointerDown={
          !preview && !selectedDrawingTool && drawingToolbarProps.cursorMode !== "eraser" && isSelected
            ? (event) => startSelectionDrag(event, drawing.id, null)
            : undefined
        }
      >
        <title>{label}</title>
        {geometry.lines.map(({ start, end }, index) =>
          Number.isFinite(start.x) && Number.isFinite(start.y) &&
          Number.isFinite(end.x) && Number.isFinite(end.y)
            ? <line
              key={index}
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              stroke={isSelected ? "#f3f3b8" : stroke}
              strokeWidth={isSelected ? strokeWidth + 1 : strokeWidth}
              strokeDasharray={dashArray}
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              pointerEvents="stroke"
            />
            : null
        )}
        {(geometry.labels || []).map((label, index) => (
          <text
            key={`label-${index}`}
            x={label.x}
            y={label.y - 3}
            fill={isSelected ? "#f3f3b8" : stroke}
            className="chart-drawing-label"
          >{label.text}</text>
        ))}
        {drawing.type === "info-line" && pointCoordinates.length >= 2 &&
          pointCoordinates.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) &&
          <text
            x={(pointCoordinates[0].x + pointCoordinates[1].x) / 2}
            y={(pointCoordinates[0].y + pointCoordinates[1].y) / 2 - 8}
            fill={isSelected ? "#f3f3b8" : stroke}
            className="chart-drawing-label"
          >{formatPrice(Math.abs(drawing.points[1].price - drawing.points[0].price), digits)} · {Math.abs(Math.round((Number(drawing.points[1].time) - Number(drawing.points[0].time)) / INTERVAL_SECONDS[interval]))} bars</text>}
        {drawing.type === "trend-angle" && pointCoordinates.length >= 2 &&
          pointCoordinates.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) &&
          <text
            x={(pointCoordinates[0].x + pointCoordinates[1].x) / 2}
            y={(pointCoordinates[0].y + pointCoordinates[1].y) / 2 - 8}
            fill={isSelected ? "#f3f3b8" : stroke}
            className="chart-drawing-label"
          >{`${(Math.atan2(
            pointCoordinates[0].y - pointCoordinates[1].y,
            pointCoordinates[1].x - pointCoordinates[0].x,
          ) * 180 / Math.PI).toFixed(1)}°`}</text>}
        {!preview && isSelected && selectionHandles.map((point, index) => (
          <circle
            key={`handle-${index}`}
            cx={point.x}
            cy={point.y}
            r={5}
            fill="#202d2e"
            stroke="#f4f3d5"
            strokeWidth={1.5}
            pointerEvents="all"
            data-drawing-id={drawing.id}
            data-point-index={index}
            className="chart-drawing-anchor"
            onPointerDown={(event) => startSelectionDrag(event, drawing.id, index)}
          />
        ))}
      </g>
    );
  }

  function handleProtectionPointerDown(event, position, field) {
    if (
      event.button !== 0 ||
      !canTrade ||
      modifyingIds.has(position.id) ||
      !Number.isFinite(Number(position.pnl_metadata?.price_decimals))
    ) return;
    event.preventDefault();
    event.stopPropagation();
    const currentPrice = Number(position[field]);
    const price = Number.isFinite(currentPrice) && currentPrice > 0
      ? currentPrice
      : Number(position.open_price);
    if (!Number.isFinite(price) || price <= 0) return;
    dragRef.current = {
      id: position.id,
      field,
      pointerId: event.pointerId,
      price,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setControlError("");
  }

  function handleProtectionPointerMove(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const position = positions.find((item) => item.id === drag.id);
    const rawPrice = priceFromPointer(event);
    const price = position && rawPrice !== null
      ? snapPriceToPositionPrecision(rawPrice, position)
      : null;
    if (price === null) return;
    drag.price = price;
    drag.moved = true;
    setDraftPrices((current) => new Map(current).set(`${drag.id}:${drag.field}`, price));
    setLayoutVersion((version) => version + 1);
  }

  async function finishProtectionDrag(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (!drag.moved) {
      dragRef.current = null;
      setDraftPrices((current) => {
        const next = new Map(current);
        next.delete(`${drag.id}:${drag.field}`);
        return next;
      });
      return;
    }
    const finalRawPrice = priceFromPointer(event);
    const position = positions.find((item) => item.id === drag.id);
    const finalPrice = position && finalRawPrice !== null
      ? snapPriceToPositionPrecision(finalRawPrice, position)
      : drag.price;
    dragRef.current = null;
    const draftKey = `${drag.id}:${drag.field}`;
    if (!position || finalPrice === null) {
      setDraftPrices((current) => {
        const next = new Map(current);
        next.delete(draftKey);
        return next;
      });
      return;
    }
    setDraftPrices((current) => new Map(current).set(draftKey, finalPrice));
    const markPrice = position.side === "BUY" ? Number(quote?.bid) : Number(quote?.ask);
    const quoteIsLive = quote?.stale !== true &&
      Number.isFinite(markPrice) &&
      markPrice > 0 &&
      latestTickTimestampMs !== null &&
      clockNow - latestTickTimestampMs >= 0 &&
      clockNow - latestTickTimestampMs <= QUOTE_FALLBACK_MS;
    const validLevel = drag.field === "stop_loss"
      ? (position.side === "BUY" ? finalPrice < markPrice : finalPrice > markPrice)
      : (position.side === "BUY" ? finalPrice > markPrice : finalPrice < markPrice);
    if (!quoteIsLive || !validLevel) {
      setControlError(!quoteIsLive
        ? "Protection levels cannot be changed while the real market quote is stale or unavailable."
        : "The level must remain on the valid side of the current executable price.");
      setDraftPrices((current) => {
        const next = new Map(current);
        next.delete(draftKey);
        return next;
      });
      return;
    }

    setModifyingIds((current) => new Set(current).add(position.id));
    setControlError("");
    try {
      const result = await onModifyPosition(position, { [drag.field]: finalPrice });
      if (result === false) throw new Error("The server did not confirm the protection-level update.");
    } catch (requestError) {
      setControlError(requestError.message || "The server rejected the protection-level update.");
    } finally {
      setDraftPrices((current) => {
        const next = new Map(current);
        next.delete(draftKey);
        return next;
      });
      setModifyingIds((current) => {
        const next = new Set(current);
        next.delete(position.id);
        return next;
      });
    }
  }

  const marketState = getMarketState(quote, quoteError);
  const highLow = candles.length ? candles.reduce((range, candle) => ({
    high: Math.max(range.high, candle.high),
    low: Math.min(range.low, candle.low),
  }), { high: -Infinity, low: Infinity }) : null;
  const visiblePositions = positions.filter((position) =>
    positionsVisible && position.status === "open" && position.symbol?.toUpperCase() === symbol
  );
  const latestCandle = candleDataRef.current[candleDataRef.current.length - 1]
    || candles[candles.length - 1];
  const historyStartTimestampMs = candles[0]?.timestampMs ?? null;
  const latestCandleTimestampMs = latestCandle?.timestampMs ?? (
    Number.isFinite(latestCandle?.time) ? latestCandle.time * 1000 : null
  );
  const displayTimeZone = chartTimeZoneRef.current;
  const hasLivePrice = quote?.mid !== null
    && quote?.mid !== undefined
    && Number.isFinite(Number(quote.mid));
  const livePrice = hasLivePrice ? Number(quote.mid) : null;
  const displayedPrice = livePrice ?? (Number.isFinite(Number(latestCandle?.close))
    ? Number(latestCandle.close)
    : null);
  const priceCoordinate = displayedPrice === null
    ? null
    : candleSeries.current?.priceToCoordinate(displayedPrice);
  const chartHeight = chartHost.current?.clientHeight ?? 0;
  const livePriceY = Number.isFinite(priceCoordinate)
    ? Math.max(16, Math.min(priceCoordinate, chartHeight - 16))
    : chartHeight > 0 ? chartHeight / 2 : null;
  const priceDirection = latestCandle && latestCandle.close >= latestCandle.open
    ? "price-up"
    : "price-down";

  return (
    <section className="chart-panel">
      <div className="chart-header">
        <div className="chart-market-title">
          <button className="icon-button mobile-only" type="button" onClick={onOpenWatchlist} aria-label="Open watchlist"><Menu size={18} /></button>
          <InstrumentMark symbol={symbol} />
          <div className="chart-title-copy"><div><h1>{symbol || "Select a market"}</h1><span className={`market-state state-text-${marketState.tone}`}>{marketState.label}</span></div><p>{SHORT_NAMES[symbol] || selected?.display_name || "Live market"}</p></div>
          <span className="chart-symbol-divider" />
          <div className="chart-ohlc"><span>HIGH <strong>{highLow ? formatPrice(highLow.high, digits) : "--"}</strong></span><span>LOW <strong>{highLow ? formatPrice(highLow.low, digits) : "--"}</strong></span></div>
        </div>
        <div className="chart-header-actions">
          <div className="interval-control" role="group" aria-label="Chart timeframe">
            {INTERVALS.map((value) => <button key={value} type="button" className={interval === value ? "interval-active" : ""} aria-pressed={interval === value} onClick={() => onIntervalChange(value)}>{value}</button>)}
          </div>
          <button className="icon-button chart-tool" type="button" title="Chart style" aria-label="Chart style"><CandlestickChart size={17} /></button>
        </div>
      </div>
      <div className={`chart-canvas-wrap chart-cursor-mode-${drawingToolbarProps.cursorMode}`} data-layout-version={layoutVersion} onWheelCapture={() => setLayoutVersion((version) => version + 1)}>
        <div className="chart-mobile-drawing-toolbar">
          <DrawingToolbar {...drawingToolbarProps} />
        </div>
      <div
        className="chart-canvas"
        ref={chartHost}
        onPointerDown={handleDrawingPointerDown}
        onPointerMove={handleDrawingPointerMove}
        onPointerLeave={() => setDrawingCursor(null)}
        aria-label={`${symbol} candlestick chart`}
      />
      <div
        className={`chart-drawing-overlay ${selectedDrawingTool || drawingToolbarProps.cursorMode === "eraser" ? "chart-drawing-overlay-active" : ""}`}
        onPointerDown={handleDrawingPointerDown}
        onPointerMove={handleDrawingPointerMove}
        onPointerLeave={() => setDrawingCursor(null)}
        style={{ cursor: selectedDrawingTool ? "crosshair" : drawingToolbarProps.cursorMode === "eraser" ? "cell" : "default" }}
          aria-label={selectedDrawingTool
            ? `${DRAWING_TOOL_BY_ID.get(selectedDrawingTool)?.label || "Drawing"} active. Click on the chart to place points. Press Escape to cancel.`
            : "Saved chart drawings"}
        >
          <svg className="chart-drawings-svg" aria-hidden="true">
            {drawingsVisible && drawings.map((drawing) => renderDrawing(drawing))}
            {!selectedDrawingTool && drawingToolbarProps.cursorMode === "dot" && drawingCursor &&
              <circle cx={chartRef.current?.timeScale().timeToCoordinate(drawingCursor.time) ?? -1}
                cy={candleSeries.current?.priceToCoordinate(drawingCursor.price) ?? -1}
                r="3" fill="#d4ed94" pointerEvents="none" />}
            {selectedDrawingTool && (() => {
              const tool = DRAWING_TOOL_BY_ID.get(selectedDrawingTool);
              const previewPoints = pendingDrawingPoints.length
                ? [...pendingDrawingPoints, ...(drawingCursor ? [drawingCursor] : [])]
                : tool?.points === 1 && drawingCursor ? [drawingCursor] : [];
              return tool && previewPoints.length
                ? renderDrawing({
                  id: "drawing-preview",
                  type: tool.id,
                  points: previewPoints.slice(0, tool.points),
                  color: "#d4ed94",
                  opacity: 1,
                  width: 2,
                  lineStyle: "solid",
                  hidden: false,
                  locked: false,
                }, true)
                : null;
            })()}
          </svg>
          {drawingContextMenu && (() => {
            const targetDrawing = drawings.find((drawing) => drawing.id === drawingContextMenu.drawingId);
            if (!targetDrawing) return null;
            const menuStyle = {
              left: `${Math.min(Math.max(drawingContextMenu.x + 12, 12), (chartHost.current?.clientWidth || 0) - 160)}px`,
              top: `${Math.min(Math.max(drawingContextMenu.y + 12, 12), (chartHost.current?.clientHeight || 0) - 240)}px`,
            };
            return (
              <div className="chart-drawing-context-menu" style={menuStyle} onPointerDown={(event) => event.stopPropagation()}>
                <button type="button" onClick={() => { setSelectedDrawingId(targetDrawing.id); setDrawingContextMenu(null); }}>Settings</button>
                <button type="button" onClick={() => {
                  const coordinates = targetDrawing.points.map((point) => `${formatPrice(point.price, digits)} @ ${String(point.time)}`).join(" | ");
                  navigator.clipboard?.writeText(coordinates).catch(() => undefined);
                  setDrawingContextMenu(null);
                }}>Coordinates</button>
                <button type="button" onClick={() => {
                  updateSelectedDrawingStyle({ hidden: !targetDrawing.hidden });
                  setDrawingContextMenu(null);
                }}>{targetDrawing.hidden ? "Show" : "Hide"}</button>
                <button type="button" onClick={() => { duplicateSelectedDrawing(); setDrawingContextMenu(null); }}>Duplicate</button>
                <button type="button" onClick={() => {
                  updateSelectedDrawingStyle({ locked: !targetDrawing.locked });
                  setDrawingContextMenu(null);
                }}>{targetDrawing.locked ? "Unlock" : "Lock"}</button>
                <button type="button" className="danger" onClick={() => {
                  onRemoveDrawing(symbol, targetDrawing.id);
                  setSelectedDrawingId(null);
                  setDrawingContextMenu(null);
                }}>Remove</button>
              </div>
            );
          })()}
          {selectedDrawingId && (() => {
            const targetDrawing = drawings.find((drawing) => drawing.id === selectedDrawingId);
            if (!targetDrawing) return null;
            return (
              <div className="chart-drawing-floating-toolbar" style={selectedDrawingToolbarStyle} onPointerDown={(event) => event.stopPropagation()}>
                <div className="chart-drawing-floating-toolbar-section">
                  <span>Color</span>
                  <div className="chart-drawing-palette">
                    {['#c8eb7b','#f3c969','#f4806a','#7ed6ff','#b597ff','#ffffff'].map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={targetDrawing.color === color ? 'active' : ''}
                        style={{ background: color }}
                        onClick={() => updateSelectedDrawingStyle({ color })}
                        aria-label={`Set drawing color to ${color}`}
                      />
                    ))}
                  </div>
                  <input type="color" value={targetDrawing.color || '#c8eb7b'} onChange={(event) => updateSelectedDrawingStyle({ color: event.target.value })} />
                </div>
                <div className="chart-drawing-floating-toolbar-section">
                  <label>
                    <span>Opacity</span>
                    <input type="range" min="0.1" max="1" step="0.05" value={targetDrawing.opacity ?? 1} onChange={(event) => updateSelectedDrawingStyle({ opacity: Number(event.target.value) })} />
                  </label>
                  <label>
                    <span>Width</span>
                    <select value={targetDrawing.width ?? 2} onChange={(event) => updateSelectedDrawingStyle({ width: Number(event.target.value) })}>
                      {[1,2,3,4,5].map((width) => <option key={width} value={width}>{width}px</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Style</span>
                    <select value={targetDrawing.lineStyle || 'solid'} onChange={(event) => updateSelectedDrawingStyle({ lineStyle: event.target.value })}>
                      <option value="solid">Solid</option>
                      <option value="dashed">Dashed</option>
                      <option value="dotted">Dotted</option>
                    </select>
                  </label>
                </div>
                <div className="chart-drawing-floating-toolbar-actions">
                  <button type="button" onClick={() => updateSelectedDrawingStyle({ locked: !targetDrawing.locked })}>{targetDrawing.locked ? 'Unlock' : 'Lock'}</button>
                  <button type="button" onClick={() => updateSelectedDrawingStyle({ hidden: !targetDrawing.hidden })}>{targetDrawing.hidden ? 'Show' : 'Hide'}</button>
                  <button type="button" onClick={duplicateSelectedDrawing}>Duplicate</button>
                  <button type="button" className="danger" onClick={() => { onRemoveDrawing(symbol, targetDrawing.id); setSelectedDrawingId(null); }}>Delete</button>
                </div>
              </div>
            );
          })()}
        </div>
        <div className={`chart-controls-floating ${chartControlsVisible ? "chart-controls-visible" : ""}`} aria-label="Chart controls" aria-hidden={!chartControlsVisible}>
          <button type="button" tabIndex={chartControlsVisible ? 0 : -1} aria-label="Zoom out" title="Zoom out" className="chart-control-button" onClick={() => handleChartControl("zoom-out")}><Minus size={14} /></button>
          <button type="button" tabIndex={chartControlsVisible ? 0 : -1} aria-label="Zoom in" title="Zoom in" className="chart-control-button" onClick={() => handleChartControl("zoom-in")}><Plus size={14} /></button>
          <button type="button" tabIndex={chartControlsVisible ? 0 : -1} aria-label="Previous range" title="Previous range" className="chart-control-button" onClick={() => handleChartControl("prev")}><ChevronLeft size={14} /></button>
          <button type="button" tabIndex={chartControlsVisible ? 0 : -1} aria-label="Next range" title="Next range" className="chart-control-button" onClick={() => handleChartControl("next")}><ChevronRight size={14} /></button>
          <button type="button" tabIndex={chartControlsVisible ? 0 : -1} aria-label="Reset chart" title="Reset chart" className="chart-control-button chart-control-button-reset" onClick={() => handleChartControl("reset")}><RotateCcw size={14} /></button>
        </div>
        <div className="chart-position-controls" aria-label="Open position chart controls">
          {Number.isFinite(livePriceY) && <div
            className={`live-price-countdown ${priceDirection}`}
            style={{ top: `${livePriceY}px` }}
            aria-label={`Current price ${displayedPrice === null ? "unavailable" : formatPrice(displayedPrice, digits)}, candle closes in ${countdownText}`}
          >
            <strong>{displayedPrice === null ? "--" : formatPrice(displayedPrice, digits)}</strong>
            <span>{countdownText}</span>
          </div>}
          {visiblePositions.map((position) => {
            const entryY = candleSeries.current?.priceToCoordinate(Number(position.open_price));
            const digitsForPosition = getPositionPriceDigits(position);
            const stalePnl = !countdownLive || position.live_tick_at == null;
            const pnlValue = position.live_tick_at == null ? null : position.floating_pnl;
            return (
              <React.Fragment key={position.id}>
                {Number.isFinite(entryY) && <div
                  className={`position-line-label ${position.side === "BUY" ? "position-line-buy" : "position-line-sell"}`}
                  style={{ top: `${entryY}px` }}
                  title={position.live_tick_at == null
                    ? "Waiting for the next accepted real market tick."
                    : stalePnl
                      ? "Last display P&L; market data is not currently live."
                      : "Display-only P&L from the latest accepted real market tick."}
                >
                  <span>{position.side} {Number(position.volume).toFixed(2)}</span>
                  <strong className={
                    pnlValue == null
                      ? "position-pnl-neutral"
                      : Number(pnlValue) >= 0
                        ? "position-pnl-positive"
                        : "position-pnl-negative"
                  }>{formatSignedMoney(pnlValue)}</strong>
                  {[
                    ["take_profit", "TP", "position-level-tp"],
                    ["stop_loss", "SL", "position-level-sl"],
                  ].map(([field, label, className]) => (
                    <button
                      key={field}
                      type="button"
                      className={`position-protection-chip ${className} ${Number(position[field]) > 0 ? "protection-set" : "protection-unset"}`}
                      aria-label={`Drag to ${position[field] == null ? "set" : "change"} ${label} for ${position.side} ${position.symbol} position ${position.id}${position[field] == null ? "" : ` at ${formatPrice(position[field], digitsForPosition)}`}`}
                      title={position[field] == null
                        ? `Drag to set ${label}`
                        : `Drag to change ${label} ${formatPrice(position[field], digitsForPosition)}`}
                      disabled={!canTrade || modifyingIds.has(position.id)}
                      onPointerDown={(event) => handleProtectionPointerDown(event, position, field)}
                      onPointerMove={handleProtectionPointerMove}
                      onPointerUp={(event) => void finishProtectionDrag(event)}
                      onPointerCancel={() => {
                        const drag = dragRef.current;
                        if (!drag || drag.id !== position.id || drag.field !== field) return;
                        dragRef.current = null;
                        setDraftPrices((current) => {
                          const next = new Map(current);
                          next.delete(`${position.id}:${field}`);
                          return next;
                        });
                      }}
                    >{label}</button>
                  ))}
                  <button
                    type="button"
                    className="position-line-close"
                    aria-label={`Close ${position.side} ${position.symbol} position ${position.id}`}
                    title={`Close position ${position.id}`}
                    disabled={!canTrade || closingIds.has(position.id)}
                    onClick={(event) => {
                      event.stopPropagation();
                      void closeChartPosition(position);
                    }}
                  >{closingIds.has(position.id) ? "…" : "×"}</button>
                </div>}
                {[
                  ["stop_loss", "SL", "position-level-sl"],
                  ["take_profit", "TP", "position-level-tp"],
                ].map(([field, label, className]) => {
                  const draftKey = `${position.id}:${field}`;
                  const rawPrice = draftPrices.has(draftKey) ? draftPrices.get(draftKey) : position[field];
                  if (rawPrice === null || rawPrice === undefined) return null;
                  const price = Number(rawPrice);
                  const y = candleSeries.current?.priceToCoordinate(price);
                  if (!Number.isFinite(price) || !Number.isFinite(y)) return null;
                  return (
                    <React.Fragment key={`${position.id}:${field}`}>
                      <button
                        type="button"
                        className={`position-level-hitarea ${className} ${modifyingIds.has(position.id) ? "position-level-busy" : ""}`}
                        style={{ top: `${y}px` }}
                        aria-label={`Drag ${label} for ${position.side} ${position.symbol} position ${position.id}; price ${formatPrice(price, digitsForPosition)}`}
                        title={`${label} ${formatPrice(price, digitsForPosition)} · drag to modify`}
                        disabled={!canTrade || modifyingIds.has(position.id)}
                        onPointerDown={(event) => handleProtectionPointerDown(event, position, field)}
                        onPointerMove={handleProtectionPointerMove}
                        onPointerUp={(event) => void finishProtectionDrag(event)}
                        onPointerCancel={() => {
                          const drag = dragRef.current;
                          if (!drag || drag.id !== position.id || drag.field !== field) return;
                          dragRef.current = null;
                          setDraftPrices((current) => {
                            const next = new Map(current);
                            next.delete(`${position.id}:${field}`);
                            return next;
                          });
                        }}
                      />
                      <span className={`position-level-label ${className}`} style={{ top: `${y}px` }}>
                        {label} {formatPrice(price, digitsForPosition)}
                      </span>
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
        {controlError && <div className="chart-control-error" role="alert">{controlError}</div>}
        {state !== "ready" && !hasLiveCandle && <div className="chart-overlay">
          {state === "loading" && <><span className="chart-loader" /><strong>Loading {symbol} candles</strong><span>Requesting {interval} market history</span></>}
          {state === "empty" && <><span className="empty-chart-icon"><BarChart3 size={22} /></span><strong>History unavailable</strong><span>No {interval} candles were returned for {symbol}.</span></>}
          {state === "error" && <><span className="empty-chart-icon error-icon"><Activity size={22} /></span><strong>Chart data unavailable</strong><span>{error || "The market service could not return candles."}</span></>}
        </div>}
        {(state === "ready" || hasLiveCandle) && <div className="chart-legend"><span className="legend-dot legend-up" />Up <span className="legend-dot legend-down" />Down <span className="legend-divider" />{candleCount} bars</div>}
      </div>
      <div className="chart-footer">
        <span><Activity size={13} /> Market data only</span>
        <div className="chart-history-range" aria-label="Chart candle timestamps">
          <span>
            <b>Start</b>
            {historyStartTimestampMs === null ? "—" : <time
              dateTime={new Date(historyStartTimestampMs).toISOString()}
              title={`UTC ${new Date(historyStartTimestampMs).toISOString()}`}
            >{formatChartRangeTimestamp(historyStartTimestampMs, displayTimeZone)}</time>}
          </span>
          <span>
            <b>Latest Candle</b>
            {latestCandleTimestampMs === null ? "—" : <time
              dateTime={new Date(latestCandleTimestampMs).toISOString()}
              title={`UTC ${new Date(latestCandleTimestampMs).toISOString()}`}
            >{formatChartRangeTimestamp(latestCandleTimestampMs, displayTimeZone)}</time>}
          </span>
          <span>
            <b>Latest Real Tick</b>
            {latestTickTimestampMs === null ? "—" : <time
              dateTime={new Date(latestTickTimestampMs).toISOString()}
              title={`UTC ${new Date(latestTickTimestampMs).toISOString()}`}
            >{formatChartRangeTimestamp(latestTickTimestampMs, displayTimeZone)}</time>}
          </span>
        </div>
        {(loadingMore || (error && candleCount > 0)) && <span
          className={error && candleCount > 0 ? "chart-history-error" : "chart-history-loading"}
          role="status"
          aria-label={error && candleCount > 0 ? `History incomplete: ${error}` : "Loading older provider candles"}
          title={error || "Loading older provider candles"}
        >{error && candleCount > 0 ? "History incomplete" : "Loading older history…"}</span>}
        <ChartTimezonePicker
          timeZone={chartTimeZone}
          exchangeTimeZone={getExchangeTimeZone(symbol)}
          now={clockNow}
          onSelect={setChartTimeZone}
        />
      </div>
    </section>
  );
}

function Stepper({ value, onChange, label }) {
  return (
    <div className="stepper" aria-label={label}>
      <button type="button" aria-label="Decrease volume" onClick={() => onChange((current) => Math.max(0.01, Number((current - 0.01).toFixed(2))))}><Minus size={13} /></button>
      <input aria-label="Volume in lots" type="number" min="0.01" step="0.01" value={value.toFixed(2)} onChange={(event) => onChange(Math.max(0.01, Number(event.target.value) || 0.01))} />
      <button type="button" aria-label="Increase volume" onClick={() => onChange((current) => Number((current + 0.01).toFixed(2)))}><Plus size={13} /></button>
    </div>
  );
}

function OrderPanel({
  symbol,
  quote,
  quoteError,
  orderOpen,
  onClose,
  account,
  rules,
  canTrade,
  onExecute,
}) {
  const [side, setSide] = useState("BUY");
  const [orderType, setOrderType] = useState("MARKET");
  const [volume, setVolume] = useState(0.1);
  const [oneClick, setOneClick] = useState(false);
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const digits = getPriceDigits(symbol);
  const marketState = getMarketState(quote, quoteError);
  const quoteSidePrice = side === "BUY" ? quote?.ask : quote?.bid;

  async function submitOrder() {
    if (!canTrade || submitting) return;
    setSubmitting(true);
    setNotice("");
    try {
      await onExecute({
        symbol,
        side,
        volume,
        order_type: orderType,
        take_profit: takeProfit === "" ? null : (Number.isFinite(Number(takeProfit)) ? Number(takeProfit) : takeProfit),
        stop_loss: stopLoss === "" ? null : (Number.isFinite(Number(stopLoss)) ? Number(stopLoss) : stopLoss),
      });
      setNotice(`${side} ${symbol} market order filled.`);
      setConfirming(false);
      setTakeProfit("");
      setStopLoss("");
    } catch (error) {
      setNotice(error.message || TRADING_ERROR_MESSAGES.server_error);
    } finally {
      setSubmitting(false);
    }
  }

  function startOrder() {
    if (!canTrade) {
      setNotice(TRADING_ERROR_MESSAGES.trading_disabled);
      return;
    }
    if (oneClick) {
      submitOrder();
    } else {
      setConfirming(true);
      setNotice("");
    }
  }

  return (
    <>
      <button className={`drawer-scrim order-scrim ${orderOpen ? "scrim-visible" : ""}`} type="button" aria-label="Close order panel" onClick={onClose} />
      <aside className={`order-panel ${orderOpen ? "order-open" : ""}`}>
        <div className="panel-heading order-heading">
          <div><span className="eyebrow">SERVER-VALIDATED EXECUTION</span><h2>New order <span className="stage-chip">MARKET</span></h2></div>
          <button className="icon-button mobile-only" type="button" aria-label="Close order panel" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="order-symbol-select">
          <InstrumentMark symbol={symbol} />
          <div><strong>{symbol || "No market selected"}</strong><small>{SHORT_NAMES[symbol] || "Select from watchlist"}</small></div>
          <span className={`market-state state-text-${marketState.tone}`}>{marketState.label}</span>
        </div>
        <div className="side-switch" role="tablist" aria-label="Order side">
          <button type="button" role="tab" aria-selected={side === "BUY"} className={side === "BUY" ? "side-buy-active" : ""} onClick={() => setSide("BUY")}><span className="side-arrow">↗</span> Buy</button>
          <button type="button" role="tab" aria-selected={side === "SELL"} className={side === "SELL" ? "side-sell-active" : ""} onClick={() => setSide("SELL")}><span className="side-arrow">↘</span> Sell</button>
        </div>
        <label className="field-label">Order type</label>
        <div className="select-wrap">
          <select value={orderType} onChange={(event) => setOrderType(event.target.value)} aria-label="Order type">
            <option value="MARKET">Market Order</option>
            <option value="LIMIT" disabled>Limit Order — unavailable</option>
          </select><ChevronDown size={15} />
        </div>
        <label className="field-label volume-label">Volume <span>Lots</span></label>
        <Stepper value={volume} onChange={setVolume} label="Order volume" />
        <div className="optional-fields-heading"><span>Risk controls</span><span>Validated by server</span></div>
        <PriceField label={`Take Profit${Number(rules?.take_profit_required) === 1 ? " · Required" : ""}`} placeholder="Price level" value={takeProfit} onChange={setTakeProfit} />
        <PriceField label={`Stop Loss${Number(rules?.stop_loss_required) === 1 ? " · Required" : ""}`} placeholder="Price level" value={stopLoss} onChange={setStopLoss} />
        <button className={`one-click-row ${oneClick ? "one-click-enabled" : ""}`} type="button" role="switch" aria-checked={oneClick} onClick={() => setOneClick((current) => !current)}>
          <span><strong>One-Click Trading</strong><small>{oneClick ? "Executes without the review step" : "Review and confirm before sending"}</small></span><span className="switch-track"><span /></span>
        </button>
        <div className="order-preview">
          <div><span>{side === "BUY" ? "Ask" : "Bid"} · display only</span><strong>{quote?.stale || quoteSidePrice == null ? "--" : formatPrice(quoteSidePrice, digits)}</strong></div>
          <div><span>Bid</span><strong>{quote?.bid == null ? "--" : formatPrice(quote.bid, digits)}</strong></div>
          <div><span>Ask</span><strong>{quote?.ask == null ? "--" : formatPrice(quote.ask, digits)}</strong></div>
          <div><span>Volume</span><strong>{volume.toFixed(2)} lots</strong></div>
        </div>
        {rules && <div className="rule-summary">
          <span>Phase {rules.phase_number ?? account?.phase_number ?? "—"}</span>
          {rules.max_lot_size != null && <span>Max lot {rules.max_lot_size}</span>}
          {rules.max_open_positions != null && <span>Max positions {rules.max_open_positions}</span>}
        </div>}
        <div className="order-actions">
          {confirming && <div className="order-confirmation" role="group" aria-label="Confirm market order">
            <span>Confirm {side} {volume.toFixed(2)} {symbol} at the current server Ask/Bid? Price will be revalidated by the Worker.</span>
            <div><button type="button" onClick={() => setConfirming(false)} disabled={submitting}>Cancel</button><button type="button" onClick={submitOrder} disabled={submitting}>{submitting ? "Sending…" : "Confirm order"}</button></div>
          </div>}
          {!confirming && <button className={`submit-order submit-${side.toLowerCase()}`} type="button" onClick={startOrder} disabled={!canTrade || submitting || !symbol} title={canTrade ? "Send a server-validated market order" : "An approved active account is required"}>
            <span>{submitting ? "Sending order…" : `${oneClick ? "Execute" : "Review"} ${side} ${symbol || "market"}`}</span>
            <strong>{quote?.stale || quoteSidePrice == null ? "--" : formatPrice(quoteSidePrice, digits)}</strong>
          </button>}
          <span className="execution-note"><Shield size={13} /> Server sets the fill price and enforces account rules.</span>
        </div>
        {notice && <div className={`order-notice ${notice.includes("filled") ? "order-notice-success" : ""}`} role="status">{notice}</div>}
      </aside>
    </>
  );
}

function PriceField({ label, placeholder, value, onChange }) {
  return (
    <label className="price-field"><span>{label}</span><input type="number" min="0" step="any" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>
  );
}

function TradingPanel({ open, onToggle, positions, trades, loading, error, canTrade, onClosePosition }) {
  const [tab, setTab] = useState("Positions");
  const [closingId, setClosingId] = useState("");

  async function closePosition(position) {
    if (!window.confirm(`Close ${position.side} ${Number(position.volume).toFixed(2)} ${position.symbol} at the current market price?`)) return;
    setClosingId(position.id);
    try {
      await onClosePosition(position);
    } finally {
      setClosingId("");
    }
  }

  return (
    <section className={`trading-panel ${open ? "trading-panel-open" : "trading-panel-closed"}`}>
      <div className="trading-panel-header">
        <div className="trading-tabs" role="tablist" aria-label="Trading activity">
          {["Positions", "Orders", "History"].map((value) => {
            const count = value === "Positions" ? positions.length : value === "History" ? trades.length : null;
            return <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? "trading-tab-active" : ""} onClick={() => setTab(value)}>{value}<span className="tab-count">{count ?? "—"}</span></button>;
          })}
        </div>
        <button className="collapse-button" type="button" onClick={onToggle} aria-label={open ? "Collapse activity panel" : "Expand activity panel"} title={open ? "Collapse panel" : "Expand panel"}>{open ? <ChevronDown size={17} /> : <ChevronUp size={17} />}</button>
      </div>
      {open && <div className="trading-content">
        {error && <div className="trading-alert" role="alert">{error}</div>}
        {tab === "Positions" && <>
          <div className="table-header position-grid">
            <span>SYMBOL</span><span>TYPE</span><span>VOLUME (LOTS)</span><span>OPEN PRICE</span>
            <span>CURRENT PRICE</span><span>T/P</span><span>S/L</span><span>P/L · USD</span><span>ACTION</span>
          </div>
          {positions.map((position) => <div className="position-row position-grid" key={position.id}>
            <strong className="position-symbol"><InstrumentMark symbol={position.symbol} />{position.symbol}</strong>
            <span className={`position-type ${position.side === "BUY" ? "direction-buy" : "direction-sell"}`}>
              <span aria-hidden="true" />{position.side === "BUY" ? "Buy" : "Sell"}
            </span>
            <span>{position.volume ?? "--"}</span>
            <span>{formatPrice(position.open_price, getPriceDigits(position.symbol))}</span>
            <span>{formatPrice(position.current_price, getPriceDigits(position.symbol))}</span>
            <span className={position.take_profit == null ? "protection-add" : "protection-value"} title={position.take_profit == null ? "Drag the TP chip on the chart to add take profit." : undefined}>
              {position.take_profit == null ? "Add" : formatPrice(position.take_profit, getPriceDigits(position.symbol))}
            </span>
            <span className={position.stop_loss == null ? "protection-add" : "protection-value"} title={position.stop_loss == null ? "Drag the SL chip on the chart to add stop loss." : undefined}>
              {position.stop_loss == null ? "Add" : formatPrice(position.stop_loss, getPriceDigits(position.symbol))}
            </span>
            <span className={`position-pnl ${Number(position.floating_pnl) >= 0 ? "position-pnl-positive" : "position-pnl-negative"}`}>
              {formatMoney(position.floating_pnl)}
            </span>
            <div className="position-actions">
              <button type="button" className="close-position-button" aria-label={`Close ${position.side} ${position.symbol} position`} onClick={() => closePosition(position)} disabled={!canTrade || closingId === position.id}>
                {closingId === position.id ? "Closing…" : "Close"}
              </button>
            </div>
          </div>)}
          {!loading && !positions.length && <div className="trading-empty"><span className="empty-table-icon"><PanelBottomClose size={18} /></span><strong>No open positions</strong><span>Positions will appear here after a server-accepted market order.</span></div>}
          {loading && !positions.length && <div className="trading-empty"><strong>Loading positions…</strong></div>}
        </>}
        {tab === "History" && <>
          <div className="table-header history-grid"><span>SYMBOL</span><span>DIRECTION</span><span>VOLUME</span><span>ENTRY</span><span>EXIT</span><span>REALIZED P&amp;L</span><span>OPENED</span><span>CLOSED</span><span>STATUS</span></div>
          {trades.map((trade) => <div className="position-row history-grid" key={trade.id}>
            <strong>{trade.symbol}</strong>
            <span>{trade.side === "BUY" ? "BUY / LONG" : "SELL / SHORT"}</span>
            <span>{trade.volume ?? "--"}</span>
            <span>{formatPrice(trade.open_price, getPriceDigits(trade.symbol))}</span>
            <span>{formatPrice(trade.close_price, getPriceDigits(trade.symbol))}</span>
            <span>{formatMoney(trade.realized_pnl)}</span>
            <span>{formatDate(trade.opened_at)}</span>
            <span>{formatDate(trade.closed_at)}</span>
            <span>Closed</span>
          </div>)}
          {!loading && !trades.length && <div className="trading-empty"><strong>No trade history</strong><span>Completed trades from this account will appear here.</span></div>}
        </>}
        {tab === "Orders" && <div className="trading-empty"><strong>Market order list unavailable</strong><span>The Worker currently exposes positions and completed trades, not a separate orders history route.</span></div>}
      </div>}
    </section>
  );
}

function formatDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "--";
}

function App() {
  const trading = useTradingSession();
  const liveTickHandler = useRef(null);
  const onAcceptedTick = useCallback(
    (tick) => trading.applyLiveTickToPositions(tick),
    [trading.applyLiveTickToPositions]
  );
  const { symbols, symbolState, symbolError, quotes, quoteErrors } = useMarketData(liveTickHandler, onAcceptedTick);
  const [selectedSymbol, setSelectedSymbol] = useState("XAUUSD");
  const [interval, setInterval] = useState("1m");
  const [watchCollapsed, setWatchCollapsed] = useState(false);
  const [selectedDrawingTool, setSelectedDrawingTool] = useState("");
  const [cursorMode, setCursorMode] = useState("cross");
  const [magnetMode, setMagnetMode] = useState("off");
  const [drawingsVisible, setDrawingsVisible] = useState(true);
  const [positionsVisible, setPositionsVisible] = useState(true);
  const [alwaysRemoveLocked, setAlwaysRemoveLocked] = useState(false);
  const [drawingsBySymbol, setDrawingsBySymbol] = useState(readStoredDrawings);
  const activeDrawings = drawingsBySymbol[selectedSymbol] || [];
  const hiddenDrawings = activeDrawings.filter((drawing) => drawing.hidden);
  const lockedDrawingCount = activeDrawings.filter((drawing) => drawing.locked).length;
  const [favorites, setFavorites] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("df-terminal-favorites") || "[\"XAUUSD\"]");
    } catch {
      return ["XAUUSD"];
    }
  });
  const [watchOpen, setWatchOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(true);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(DRAWINGS_STORAGE_KEY, JSON.stringify(drawingsBySymbol));
    } catch (error) {
      console.warn("Unable to save chart drawings.", error);
    }
  }, [drawingsBySymbol]);

  useEffect(() => {
    const handleDrawingShortcut = (event) => {
      if (event.key === "Escape" && (selectedDrawingTool || cursorMode !== "cross")) {
        setSelectedDrawingTool("");
        setCursorMode("cross");
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) return;
      const shortcut = `alt${event.shiftKey ? "shift" : ""}${event.key.toLowerCase()}`;
      const toolId = DRAWING_SHORTCUTS.get(shortcut);
      if (!toolId) return;
      event.preventDefault();
      setCursorMode("cross");
      setSelectedDrawingTool(toolId);
    };
    window.addEventListener("keydown", handleDrawingShortcut);
    return () => window.removeEventListener("keydown", handleDrawingShortcut);
  }, [cursorMode, selectedDrawingTool]);

  const addChartDrawing = useCallback((symbol, drawing) => {
    setDrawingsBySymbol((current) => ({
      ...current,
      [symbol]: [...(current[symbol] || []), drawing],
    }));
  }, []);

  const clearChartDrawings = useCallback(() => {
    setDrawingsBySymbol((current) => {
      const drawings = current[selectedSymbol] || [];
      const remaining = alwaysRemoveLocked ? [] : drawings.filter((drawing) => drawing.locked);
      if (remaining.length === drawings.length) return current;
      return { ...current, [selectedSymbol]: remaining };
    });
  }, [alwaysRemoveLocked, selectedSymbol]);
  const removeDrawing = useCallback((symbol, drawingId) => {
    setDrawingsBySymbol((current) => {
      const drawings = current[symbol] || [];
      const drawing = drawings.find((item) => item.id === drawingId);
      if (!drawing || (drawing.locked && !alwaysRemoveLocked)) return current;
      return { ...current, [symbol]: drawings.filter((item) => item.id !== drawingId) };
    });
  }, [alwaysRemoveLocked]);
  const removeLatestDrawing = useCallback(() => {
    const drawings = activeDrawings;
    const target = [...drawings].reverse().find((drawing) => alwaysRemoveLocked || !drawing.locked);
    if (target) removeDrawing(selectedSymbol, target.id);
  }, [activeDrawings, alwaysRemoveLocked, removeDrawing, selectedSymbol]);
  const toggleDrawingLocks = useCallback(() => {
    setDrawingsBySymbol((current) => {
      const drawings = current[selectedSymbol] || [];
      if (!drawings.length) return current;
      const shouldLock = !drawings.every((drawing) => drawing.locked);
      return {
        ...current,
        [selectedSymbol]: drawings.map((drawing) => ({ ...drawing, locked: shouldLock })),
      };
    });
  }, [selectedSymbol]);
  const drawingToolbarProps = {
    selectedTool: selectedDrawingTool,
    onSelectTool: setSelectedDrawingTool,
    cursorMode,
    onSetCursorMode: setCursorMode,
    onToggleLock: toggleDrawingLocks,
    onRemoveLatestDrawing: removeLatestDrawing,
    onClearDrawings: clearChartDrawings,
    drawingCount: activeDrawings.length,
    lockedDrawingCount,
    alwaysRemoveLocked,
    onToggleAlwaysRemoveLocked: (event) => setAlwaysRemoveLocked(event.target.checked),
    magnetMode,
    onSetMagnetMode: setMagnetMode,
    drawingsVisible,
    onToggleVisibility: () => setDrawingsVisible((current) => !current),
    positionsVisible,
    onTogglePositionsVisibility: () => setPositionsVisible((current) => !current),
    onHideAll: () => {
      const currentlyVisible = drawingsVisible || positionsVisible;
      setDrawingsVisible(!currentlyVisible);
      setPositionsVisible(!currentlyVisible);
    },
    hiddenDrawings,
    onShowDrawing: (drawingId) => {
      setDrawingsBySymbol((current) => ({
        ...current,
        [selectedSymbol]: (current[selectedSymbol] || []).map((drawing) =>
          drawing.id === drawingId ? { ...drawing, hidden: false } : drawing),
      }));
    },
    onZoomIn: () => window.dispatchEvent(new Event("df-chart-zoom-in")),
  };
  const selected = symbols.find((item) => item.symbol === selectedSymbol) || null;
  const quote = quotes[selectedSymbol] || null;
  const quoteError = quoteErrors[selectedSymbol] || null;
  const {
    candles,
    state: candleState,
    error: candleError,
    dataKey: candleDataKey,
    loadingMore: candleHistoryLoading,
    hasMoreHistory: candleHasMoreHistory,
    loadOlderHistory,
  } = useCandles(selected ? selectedSymbol : "", interval);
  const liveOpenPnl = trading.positions
    .filter((position) => position.status === "open")
    .reduce((total, position) => {
      if (position.floating_pnl == null) return total;
      const value = Number(position.floating_pnl);
      return Number.isFinite(value) ? total + value : total;
    }, 0);
  const accountOpenPnl = Number(trading.account?.open_pnl);
  const livePnlDelta = Number.isFinite(accountOpenPnl)
    ? liveOpenPnl - accountOpenPnl
    : 0;
  const adjustAccountMetric = (value) => {
    if (value == null || !Number.isFinite(Number(value))) return value;
    return Number(value) + livePnlDelta;
  };
  const openPnl = trading.account ? liveOpenPnl : trading.selectedAccount?.open_pnl;
  const equity = adjustAccountMetric((trading.account || trading.selectedAccount)?.equity);
  const freeMargin = adjustAccountMetric(
    (trading.account || trading.selectedAccount)?.free_margin ??
    (trading.account || trading.selectedAccount)?.available_margin
  );

  useEffect(() => {
    if (symbolState !== "ready" || symbols.some((item) => item.symbol === selectedSymbol)) return;
    setSelectedSymbol(symbols.find((item) => item.symbol === "XAUUSD")?.symbol || symbols[0]?.symbol || "");
  }, [symbolState, symbols, selectedSymbol]);

  function toggleFavorite(symbol) {
    setFavorites((current) => {
      const next = current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol];
      try {
        localStorage.setItem("df-terminal-favorites", JSON.stringify(next));
      } catch {
        // Favorites remain usable for this session when storage is unavailable.
      }
      return next;
    });
  }

  function selectSymbol(symbol) {
    setSelectedSymbol(symbol);
    setWatchOpen(false);
  }

  async function executeOrder(order) {
    if (!trading.canTrade || !trading.selectedAccount) {
      throw new TradingRequestError("trading_disabled", 409);
    }
    const result = await getTradingJson("/trading/positions", trading.user, {
      method: "POST",
      body: JSON.stringify({
        account_id: trading.selectedAccount.id,
        ...order,
      }),
    });
    trading.addConfirmedPosition(result.position);
    setActionError("");
    trading.refresh();
  }

  async function closePosition(position) {
    if (!trading.canTrade || !trading.selectedAccount) return false;
    try {
      const result = await getTradingJson("/trading/positions/close", trading.user, {
        method: "POST",
        body: JSON.stringify({ position_id: position.id }),
      });
      if (result.position?.id !== position.id || result.position.status !== "closed") {
        throw new TradingRequestError("server_response_invalid", 502);
      }
      trading.applyAuthoritativePositionEvent({
        type: "POSITION_CLOSED",
        position_id: position.id,
        account_id: position.account_id,
        position: result.position,
        trade: result.trade,
        account: result.account,
      });
      setActionError("");
      return true;
    } catch (error) {
      setActionError(error.message || TRADING_ERROR_MESSAGES.server_error);
      return false;
    }
  }

  async function modifyPosition(position, changes) {
    if (!trading.canTrade || !trading.selectedAccount) {
      throw new TradingRequestError("trading_disabled", 409);
    }
    try {
      const result = await getTradingJson("/trading/positions/modify", trading.user, {
        method: "POST",
        body: JSON.stringify({
          position_id: position.id,
          ...changes,
        }),
      });
      if (result.position?.id !== position.id || result.position.status !== "open") {
        throw new TradingRequestError("server_response_invalid", 502);
      }
      trading.addConfirmedPosition(result.position);
      setActionError("");
      trading.refresh();
      return true;
    } catch (error) {
      setActionError(error.message || TRADING_ERROR_MESSAGES.server_error);
      throw error;
    }
  }

  const tradingError = actionError || trading.error ||
    (trading.authStatus === "signed-out" ? TRADING_ERROR_MESSAGES.authentication_required : "");

  if (trading.authStatus === "signed-out" || trading.authStatus === "unavailable") {
    return (
      <main className="auth-required-screen">
        <section className="auth-required-card">
          <h1>Please sign in to Daily Funded to trade</h1>
          <p>Your existing Daily Funded session will be used here.</p>
          <a href="/">Return to Daily Funded</a>
        </section>
      </main>
    );
  }

  return (
    <div className="terminal-shell">
      <TopBar
        symbol={selectedSymbol}
        selected={selected}
        quote={quote}
        quoteError={quoteError}
        watchOpen={watchOpen}
        onToggleWatch={() => setWatchOpen((current) => !current)}
        onToggleOrder={() => setOrderOpen(true)}
        account={trading.account || trading.selectedAccount}
        equity={equity}
        freeMargin={freeMargin}
        openPnl={openPnl}
        accounts={trading.accounts}
        accountsLoading={trading.accountsLoading}
        selectedAccountId={trading.selectedAccountId}
        onAccountChange={trading.setSelectedAccountId}
        authStatus={trading.authStatus}
        accountStatus={trading.account?.status || trading.selectedAccount?.status}
        selectedAccount={trading.selectedAccount}
      />
      <div className={`terminal-workspace ${watchCollapsed ? "workspace-watchlist-collapsed" : ""}`}>
        <Watchlist
          symbols={symbols}
          quotes={quotes}
          quoteErrors={quoteErrors}
          selectedSymbol={selectedSymbol}
          favorites={favorites}
          onSelect={selectSymbol}
          onFavorite={toggleFavorite}
          loading={symbolState === "loading"}
          error={symbolState === "error" ? symbolError : ""}
          collapsed={watchCollapsed}
          onToggleCollapse={() => setWatchCollapsed((current) => !current)}
          drawingToolbarProps={drawingToolbarProps}
          open={watchOpen}
          onClose={() => setWatchOpen(false)}
        />
        <main className="terminal-main">
          <ChartView
            symbol={selectedSymbol}
            selected={selected}
            quote={quote}
            quoteError={quoteError}
            candles={candles}
            candleDataKey={candleDataKey}
            state={selected ? candleState : symbolState === "loading" ? "loading" : "empty"}
            error={candleError || symbolError}
            loadingMore={candleHistoryLoading}
            hasMoreHistory={candleHasMoreHistory}
            loadOlderHistory={loadOlderHistory}
            interval={interval}
            onIntervalChange={setInterval}
            onOpenWatchlist={() => setWatchOpen(true)}
            selectedDrawingTool={selectedDrawingTool}
            drawings={activeDrawings}
            setDrawingsBySymbol={setDrawingsBySymbol}
            onCreateDrawing={addChartDrawing}
            onSelectDrawingTool={setSelectedDrawingTool}
            drawingToolbarProps={drawingToolbarProps}
            onRemoveDrawing={removeDrawing}
            magnetMode={magnetMode}
            drawingsVisible={drawingsVisible}
            positionsVisible={positionsVisible}
            liveTickHandler={liveTickHandler}
            positions={trading.positions}
            canTrade={trading.canTrade}
            onClosePosition={closePosition}
            onModifyPosition={modifyPosition}
          />
          <TradingPanel
            open={activityOpen}
            onToggle={() => setActivityOpen((current) => !current)}
            positions={trading.positions}
            trades={trading.trades}
            loading={trading.accountsLoading || trading.dataLoading || trading.authStatus === "loading"}
            error={tradingError}
            canTrade={trading.canTrade}
            onClosePosition={closePosition}
          />
        </main>
        <OrderPanel
          symbol={selectedSymbol}
          quote={quote}
          quoteError={quoteError}
          orderOpen={orderOpen}
          onClose={() => setOrderOpen(false)}
          account={trading.account}
          rules={trading.rules}
          canTrade={trading.canTrade}
          onExecute={executeOrder}
        />
      </div>
      <nav className="mobile-bottom-nav" aria-label="Terminal panels">
        <button type="button" onClick={() => setWatchOpen(true)}><Menu size={17} /><span>Markets</span></button>
        <button type="button" onClick={() => setActivityOpen((current) => !current)}><BarChart3 size={17} /><span>Activity</span></button>
        <button type="button" onClick={() => setOrderOpen(true)}><Activity size={17} /><span>Order</span></button>
      </nav>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);