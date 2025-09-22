type SliceResponse = {
  type: "slice_response";
  startRow: number;
  rowCount: number;
  startCol: number;
  colCount: number;
  colLetters: string[];
  cellsByRow: string[][];
};

export function drawGridAndCells(
  ctx: CanvasRenderingContext2D,
  msg: SliceResponse,
  opts: {
    defaultColumnWidth: number;
    defaultRowHeight: number;
    offsetX?: number; // negative modulo px offset for partial column
    offsetY?: number; // negative modulo px offset for partial row
    headerRowHeight?: number; // height of the column header row
    headerColWidth?: number;  // width of the row header column
    selection?: { row: number; col: number } | null;
  }
) {
  const { defaultColumnWidth: cw, defaultRowHeight: rh } = opts;
  const offsetX = opts.offsetX ?? 0;
  const offsetY = opts.offsetY ?? 0;
  const headerRowHeight = opts.headerRowHeight ?? 28;
  const headerColWidth = opts.headerColWidth ?? 88;
  const canvas = ctx.canvas;
  const width = canvas.width / (window.devicePixelRatio || 1);
  const height = canvas.height / (window.devicePixelRatio || 1);

  ctx.clearRect(0, 0, width, height);

  ctx.save();
  // Background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // Header backgrounds
  ctx.fillStyle = "#f3f4f6"; // gray-100
  // Column header row
  ctx.fillRect(headerColWidth, 0, width - headerColWidth, headerRowHeight);
  // Row header column
  ctx.fillRect(0, headerRowHeight, headerColWidth, height - headerRowHeight);

  // Grid lines
  ctx.strokeStyle = "#e5e7eb"; // tailwind gray-200
  ctx.lineWidth = 1;

  // Vertical lines (data area and column header)
  const totalV = msg.colCount + 1;
  for (let c = 0; c < totalV; c++) {
    const x = Math.floor(headerColWidth + offsetX + c * cw) + 0.5;
    // Column header separator
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, headerRowHeight);
    ctx.stroke();
    // Data area separator
    ctx.beginPath();
    ctx.moveTo(x, headerRowHeight);
    ctx.lineTo(x, Math.min(height, headerRowHeight + msg.rowCount * rh));
    ctx.stroke();
  }

  // Horizontal lines (data area and row header)
  const totalH = msg.rowCount + 1;
  for (let r = 0; r < totalH; r++) {
    const y = Math.floor(headerRowHeight + offsetY + r * rh) + 0.5;
    // Row header separator
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(headerColWidth, y);
    ctx.stroke();
    // Data area separator
    ctx.beginPath();
    ctx.moveTo(headerColWidth, y);
    ctx.lineTo(Math.min(width, headerColWidth + msg.colCount * cw), y);
    ctx.stroke();
  }

  // Text
  ctx.fillStyle = "#111827"; // gray-900
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
  ctx.textBaseline = "alphabetic";

  const paddingX = 6;
  const baselineOffset = 6; // approx bottom padding

  // Column header labels (A, B, C, ...)
  ctx.fillStyle = "#111827";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let c = 0; c < msg.colCount; c++) {
    const xCenter = headerColWidth + offsetX + c * cw + cw / 2;
    const yCenter = headerRowHeight / 2;
    const label = msg.colLetters[c] ?? "";
    if (xCenter + cw / 2 < headerColWidth || xCenter - cw / 2 > width) continue;
    ctx.fillText(label, xCenter, yCenter);
  }

  // Row header numbers
  for (let r = 0; r < msg.rowCount; r++) {
    const xCenter = headerColWidth / 2;
    const yCenter = headerRowHeight + offsetY + r * rh + rh / 2;
    const rowNumber = (msg.startRow + r + 1).toString();
    if (yCenter + rh / 2 < headerRowHeight || yCenter - rh / 2 > height) continue;
    ctx.fillText(rowNumber, xCenter, yCenter);
  }

  // Reset alignment for cell text
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const rows = Math.min(msg.rowCount, msg.cellsByRow.length);
  for (let r = 0; r < rows; r++) {
    const row = msg.cellsByRow[r];
    const cols = Math.min(msg.colCount, row.length);
    const y = headerRowHeight + offsetY + (r + 1) * rh - baselineOffset;
    for (let c = 0; c < cols; c++) {
      const text = row[c] ?? "";
      const x = headerColWidth + offsetX + c * cw + paddingX;
      ctx.fillText(text, x, y);
    }
  }

  // Selection rectangle
  if (opts.selection) {
    const sel = opts.selection;
    const inRow = sel.row >= msg.startRow && sel.row < msg.startRow + msg.rowCount;
    const inCol = sel.col >= msg.startCol && sel.col < msg.startCol + msg.colCount;
    if (inRow && inCol) {
      const localRow = sel.row - msg.startRow;
      const localCol = sel.col - msg.startCol;
      const x = headerColWidth + offsetX + localCol * cw + 0.5;
      const y = headerRowHeight + offsetY + localRow * rh + 0.5;
      ctx.save();
      ctx.strokeStyle = "#3b82f6"; // blue-500
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, cw, rh);
      ctx.restore();
    }
  }

  ctx.restore();
}
