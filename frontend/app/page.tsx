"use client";

import { useEffect, useRef, useState } from "react";
import { computeWindow } from "../lib/grid";
import { drawGridAndCells } from "../lib/draw";

const WS_URL = "ws://127.0.0.1:4001/ws";

const DEFAULT_COLUMN_WIDTH = 100;
const DEFAULT_ROW_HEIGHT = 24;
const H_BUFFER = 2;
const V_BUFFER = 5;
const FALLBACK_MAX_ROWS = 1_000_000_000; // used until metadata arrives
const FALLBACK_MAX_COLS = 1_000;
// Browser scrollTop caps around ~16,777,215px on many engines; stay below.
const MAX_SCROLL_HEIGHT = 16_000_000;
const HEADER_ROW_HEIGHT = 28;
const HEADER_COL_WIDTH = 88; // wider to fit up to 8-digit row numbers comfortably
// Configurable: how many rows to move per scroll increment / snap for drag
const SCROLL_STEP_ROWS = 3; 

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [maxRows, setMaxRows] = useState<number>(FALLBACK_MAX_ROWS);
  const [maxCols, setMaxCols] = useState<number>(FALLBACK_MAX_COLS);
  const maxRowsRef = useRef(maxRows);
  const maxColsRef = useRef(maxCols);
  const latestSliceRef = useRef<any>(null);
  const selRef = useRef<{ row: number; col: number }>({ row: 0, col: 0 });

  useEffect(() => {
    maxRowsRef.current = maxRows;
  }, [maxRows]);

  useEffect(() => {
    maxColsRef.current = maxCols;
  }, [maxCols]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const scroller = scrollerRef.current;
    if (!canvas || !scroller) return;

    let ws: WebSocket | null = null;
    let rafPending = false;
    let lastSentKey = "";
    let reconnectTimer: number | null = null;
    let destroyed = false;
    let socketOpen = false;

    const stepHeight = SCROLL_STEP_ROWS * DEFAULT_ROW_HEIGHT;

    const resizeAndScale = () => {
      const rect = scroller.getBoundingClientRect();
      const currentDpr = window.devicePixelRatio || 1;
      // Canvas is fixed-size overlay matching the visible viewport of scroller
      canvas.style.width = `${Math.floor(rect.width)}px`;
      canvas.style.height = `${Math.floor(rect.height)}px`;
      canvas.width = Math.max(1, Math.floor(rect.width * currentDpr));
      canvas.height = Math.max(1, Math.floor(rect.height * currentDpr));
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(currentDpr, currentDpr);
      }
    };

    const getViewportSize = () => {
      const rect = scroller.getBoundingClientRect();
      const viewportWidth = Math.max(0, Math.floor(rect.width - HEADER_COL_WIDTH));
      const viewportHeight = Math.max(0, Math.floor(rect.height - HEADER_ROW_HEIGHT));
      return { viewportWidth, viewportHeight };
    };

    const logicalFromVisual = () => {
      const { viewportHeight } = getViewportSize();
      const totalDatasetHeightPx = maxRowsRef.current * DEFAULT_ROW_HEIGHT;
      const visualScrollable = Math.max(0, MAX_SCROLL_HEIGHT - viewportHeight);
      const logicalScrollable = Math.max(0, totalDatasetHeightPx - viewportHeight);
      if (visualScrollable <= 0 || logicalScrollable <= 0) return 0;
      const ratio = Math.max(0, Math.min(1, scroller.scrollTop / visualScrollable));
      return ratio * logicalScrollable;
    };

    const quantizeLogical = (logicalTop: number) => {
      if (stepHeight <= 1) return logicalTop;
      return Math.round(logicalTop / stepHeight) * stepHeight;
    };

    const toVisualScrollTop = (logicalTop: number) => {
      const { viewportHeight } = getViewportSize();
      const totalDatasetHeightPx = maxRowsRef.current * DEFAULT_ROW_HEIGHT;
      const visualScrollable = Math.max(0, MAX_SCROLL_HEIGHT - viewportHeight);
      const logicalScrollable = Math.max(0, totalDatasetHeightPx - viewportHeight);
      if (logicalScrollable <= 0 || visualScrollable <= 0) return 0;
      const ratio = Math.max(0, Math.min(1, logicalTop / logicalScrollable));
      return ratio * visualScrollable;
    };

    const ensureVisualSyncedToQuantized = (quantLogicalTop: number) => {
      const desired = toVisualScrollTop(quantLogicalTop);
      if (Math.abs(scroller.scrollTop - desired) > 0.5) {
        scroller.scrollTop = desired;
      }
    };

    const redraw = () => {
      const current = latestSliceRef.current;
      if (!current) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const offsetX = - (scroller.scrollLeft % DEFAULT_COLUMN_WIDTH);
      const rawLogicalTop = logicalFromVisual();
      const qLogicalTop = quantizeLogical(rawLogicalTop);
      ensureVisualSyncedToQuantized(qLogicalTop);
      const offsetY = - (Math.floor(qLogicalTop) % DEFAULT_ROW_HEIGHT);
      drawGridAndCells(ctx, current, {
        defaultColumnWidth: DEFAULT_COLUMN_WIDTH,
        defaultRowHeight: DEFAULT_ROW_HEIGHT,
        offsetX,
        offsetY,
        headerRowHeight: HEADER_ROW_HEIGHT,
        headerColWidth: HEADER_COL_WIDTH,
        selection: selRef.current,
      });
    };

    const connect = () => {
      if (destroyed) return;
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        socketOpen = true;
        ws?.send(JSON.stringify({ type: "metadata_request" }));
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "metadata_response") {
          setMaxRows(msg.maxRows ?? FALLBACK_MAX_ROWS);
          setMaxCols(msg.maxCols ?? FALLBACK_MAX_COLS);
          requestSlice();
          return;
        }
        if (msg.type === "slice_response") {
          latestSliceRef.current = msg;
          redraw();
        }
      };

      ws.onclose = () => {
        socketOpen = false;
        if (!destroyed) {
          reconnectTimer = window.setTimeout(connect, 2000);
        }
      };

      ws.onerror = (err) => {
        console.error("WebSocket error", err);
      };
    };

    const requestSlice = () => {
      if (!socketOpen) return;
      const { viewportWidth, viewportHeight } = getViewportSize();
      const screenWidth = viewportWidth;
      const screenHeight = viewportHeight;
      const scrollLeft = Math.floor(scroller.scrollLeft);
      const rawLogicalTop = logicalFromVisual();
      const qLogicalTop = quantizeLogical(rawLogicalTop);
      const scrollTop = Math.floor(qLogicalTop);

      const slice = computeWindow({
        screenWidth,
        screenHeight,
        horizontalBuffer: H_BUFFER,
        verticalBuffer: V_BUFFER,
        defaultColumnWidth: DEFAULT_COLUMN_WIDTH,
        defaultRowHeight: DEFAULT_ROW_HEIGHT,
        scrollLeft,
        scrollTop,
        maxRows: maxRowsRef.current,
        maxCols: maxColsRef.current,
      });
      const key = `${slice.startRow}:${slice.rowCount}:${slice.startCol}:${slice.colCount}`;
      if (key === lastSentKey) return;
      lastSentKey = key;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(
          JSON.stringify({
            type: "slice_request",
            screenWidth,
            screenHeight,
            horizontalBuffer: H_BUFFER,
            verticalBuffer: V_BUFFER,
            defaultColumnWidth: DEFAULT_COLUMN_WIDTH,
            defaultRowHeight: DEFAULT_ROW_HEIGHT,
            scrollLeft,
            scrollTop,
          })
        );
      } catch (err) {
        console.error("slice_request failed", err);
      }
    };

    const onResize = () => {
      // Resize canvas to new DPR/viewport, then redraw immediately
      // using the currently cached slice to avoid a blank frame.
      resizeAndScale();
      redraw();
      requestSlice();
    };
    window.addEventListener("resize", onResize);

    const onScroll = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        // Always redraw with current offsets if we have data
        redraw();
        // And request a new slice if we've crossed a row/column boundary
        requestSlice();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });

    const ensureCellVisible = (row: number, col: number) => {
      const { viewportWidth, viewportHeight } = getViewportSize();

      // Current logical scroll top
      const logicalScrollTop = logicalFromVisual();

      // Vertical adjustments
      const startRow = Math.floor(logicalScrollTop / DEFAULT_ROW_HEIGHT);
      const visibleRows = Math.max(1, Math.floor(viewportHeight / DEFAULT_ROW_HEIGHT));
      let targetLogicalTop = logicalScrollTop;
      if (row < startRow) {
        targetLogicalTop = row * DEFAULT_ROW_HEIGHT;
      } else if (row >= startRow + visibleRows) {
        targetLogicalTop = (row + 1) * DEFAULT_ROW_HEIGHT - viewportHeight;
      }
      const totalDatasetHeightPx = maxRowsRef.current * DEFAULT_ROW_HEIGHT;
      const logicalScrollable = Math.max(0, totalDatasetHeightPx - viewportHeight);
      targetLogicalTop = Math.max(0, Math.min(targetLogicalTop, logicalScrollable));
      targetLogicalTop = quantizeLogical(targetLogicalTop);
      const newVisualTop = toVisualScrollTop(targetLogicalTop);
      if (!Number.isNaN(newVisualTop)) scroller.scrollTop = newVisualTop;

      // Horizontal adjustments
      const currentLeft = scroller.scrollLeft;
      const startCol = Math.floor(currentLeft / DEFAULT_COLUMN_WIDTH);
      const visibleCols = Math.max(1, Math.floor(viewportWidth / DEFAULT_COLUMN_WIDTH));
      let targetLeft = currentLeft;
      if (col < startCol) {
        targetLeft = col * DEFAULT_COLUMN_WIDTH;
      } else if (col >= startCol + visibleCols) {
        targetLeft = (col + 1) * DEFAULT_COLUMN_WIDTH - viewportWidth;
      }
      const totalWidthPx = maxColsRef.current * DEFAULT_COLUMN_WIDTH;
      targetLeft = Math.max(0, Math.min(targetLeft, Math.max(0, totalWidthPx - viewportWidth)));
      scroller.scrollLeft = targetLeft;
    };

    const screenToCell = (clientX: number, clientY: number) => {
      const rect = scroller.getBoundingClientRect();
      // If clicking on headers, ignore (optional: could implement header selection later)
      if (clientX - rect.left < HEADER_COL_WIDTH) return null;
      if (clientY - rect.top < HEADER_ROW_HEIGHT) return null;

      const xIn = clientX - rect.left - HEADER_COL_WIDTH + scroller.scrollLeft;
      const qLogicalTop = quantizeLogical(logicalFromVisual());
      const yIn = clientY - rect.top - HEADER_ROW_HEIGHT + qLogicalTop;
      const col = Math.max(0, Math.floor(xIn / DEFAULT_COLUMN_WIDTH));
      const row = Math.max(0, Math.floor(yIn / DEFAULT_ROW_HEIGHT));
      return { row, col };
    };

    const onMouseDown = (e: MouseEvent) => {
      const cell = screenToCell(e.clientX, e.clientY);
      if (!cell) return;
      const { row, col } = cell;
      selRef.current = { row, col };
      ensureCellVisible(row, col);
      requestSlice();
      requestAnimationFrame(redraw);
      e.preventDefault();
    };
    scroller.addEventListener("mousedown", onMouseDown as any);

    const onKeyDown = (e: KeyboardEvent) => {
      let { row, col } = selRef.current;
      const meta = e.metaKey || e.ctrlKey;
      const current = latestSliceRef.current as
        | {
            startRow: number;
            rowCount: number;
            startCol: number;
            colCount: number;
            cellsByRow: string[][];
          }
        | null;

      const isInSlice = (r: number, c: number) => {
        if (!current) return false;
        return (
          r >= current.startRow &&
          r < current.startRow + current.rowCount &&
          c >= current.startCol &&
          c < current.startCol + current.colCount
        );
      };
      const isFilled = (r: number, c: number) => {
        if (!current) return false;
        if (!isInSlice(r, c)) return false;
        const rr = r - current.startRow;
        const cc = c - current.startCol;
        const v = current.cellsByRow[rr]?.[cc];
        return v != null && v !== "";
      };
      const jumpEdge = (dir: "left" | "right" | "up" | "down") => {
        if (!current) {
          // Fallback to sheet edges if we have no data
          if (dir === "left") col = 0;
          if (dir === "right") col = maxCols - 1;
          if (dir === "up") row = 0;
          if (dir === "down") row = maxRows - 1;
          return;
        }
        // If selection not in slice, fallback to edges
        if (!isInSlice(row, col)) {
          if (dir === "left") col = current.startCol;
          if (dir === "right") col = current.startCol + current.colCount - 1;
          if (dir === "up") row = current.startRow;
          if (dir === "down") row = current.startRow + current.rowCount - 1;
          return;
        }
        const localRow = row - current.startRow;
        const localCol = col - current.startCol;
        if (dir === "left") {
          let cc = localCol;
          while (cc - 1 >= 0 && isFilled(row, current.startCol + cc - 1)) cc--;
          col = current.startCol + cc;
        } else if (dir === "right") {
          let cc = localCol;
          while (
            cc + 1 < current.colCount &&
            isFilled(row, current.startCol + cc + 1)
          )
            cc++;
          col = current.startCol + cc;
        } else if (dir === "up") {
          let rr = localRow;
          while (rr - 1 >= 0 && isFilled(current.startRow + rr - 1, col)) rr--;
          row = current.startRow + rr;
        } else if (dir === "down") {
          let rr = localRow;
          while (
            rr + 1 < current.rowCount &&
            isFilled(current.startRow + rr + 1, col)
          )
            rr++;
          row = current.startRow + rr;
        }
      };
      const totalRows = Math.max(1, maxRowsRef.current);
      const totalCols = Math.max(1, maxColsRef.current);

      switch (e.key) {
        case "ArrowUp":
          row = Math.max(0, row - 1);
          break;
        case "ArrowDown":
          row = Math.min(totalRows - 1, row + 1);
          break;
        case "ArrowLeft":
          col = Math.max(0, col - 1);
          break;
        case "ArrowRight":
          col = Math.min(totalCols - 1, col + 1);
          break;
        case "Home":
          col = 0;
          break;
        case "End":
          col = totalCols - 1;
          break;
        default:
          // Cmd/Ctrl + Arrow behavior: jump to nearest filled edge within current slice.
          if (meta && e.key === "ArrowLeft") jumpEdge("left");
          else if (meta && e.key === "ArrowRight") jumpEdge("right");
          else if (meta && e.key === "ArrowUp") jumpEdge("up");
          else if (meta && e.key === "ArrowDown") jumpEdge("down");
          else return; // let other keys pass through
      }
      selRef.current = { row, col };
      ensureCellVisible(row, col);
      requestAnimationFrame(redraw);
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);

    resizeAndScale();
    connect();

    return () => {
      window.removeEventListener("resize", onResize);
      scroller.removeEventListener("scroll", onScroll as any);
      scroller.removeEventListener("mousedown", onMouseDown as any);
      window.removeEventListener("keydown", onKeyDown);
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer);
      }
      if (ws) {
        try {
          ws.onopen = null;
          ws.onmessage = null;
          ws.onclose = null;
          ws.onerror = null;
          ws.close();
        } catch (err) {
          console.error("error closing websocket", err);
        }
      }
      destroyed = true;
    };
  }, []);

  return (
    <div
      ref={scrollerRef}
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "auto",
        position: "relative",
      }}
    >
      {/* Sticky overlay canvas stays in view while scrolling */}
      <canvas
        ref={canvasRef}
        style={{
          position: "sticky",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          display: "block",
          pointerEvents: "none",
          zIndex: 1,
        }}
      />
      {/* Virtual content to produce scrollbars matching entire dataset */}
      <div
        style={{
          width: `${maxCols * DEFAULT_COLUMN_WIDTH}px`,
          height: `${Math.min(maxRows * DEFAULT_ROW_HEIGHT, MAX_SCROLL_HEIGHT)}px`,
        }}
      />
    </div>
  );
}
