export type ComputeWindowInput = {
  screenWidth: number;
  screenHeight: number;
  horizontalBuffer: number;
  verticalBuffer: number;
  defaultColumnWidth: number;
  defaultRowHeight: number;
  scrollLeft: number;
  scrollTop: number;
  maxRows: number;
  maxCols: number;
};

export type WindowSlice = {
  startRow: number;
  rowCount: number;
  startCol: number;
  colCount: number;
};

export function computeWindow(inp: ComputeWindowInput): WindowSlice {
  const startRow = Math.floor(inp.scrollTop / inp.defaultRowHeight);
  const visibleRows = Math.ceil(inp.screenHeight / inp.defaultRowHeight);
  const startCol = Math.floor(inp.scrollLeft / inp.defaultColumnWidth);
  const visibleCols = Math.ceil(inp.screenWidth / inp.defaultColumnWidth);

  const rowCount = Math.min(
    visibleRows + inp.verticalBuffer * 2,
    Math.max(0, inp.maxRows - startRow)
  );

  const colCount = Math.min(
    visibleCols + inp.horizontalBuffer * 2,
    Math.max(0, inp.maxCols - startCol)
  );

  return { startRow, rowCount, startCol, colCount };
}

export function columnIndexToLetters(index: number): string {
  // 0 -> A, 25 -> Z, 26 -> AA ...
  let n = index >>> 0;
  const chars: string[] = [];
  while (true) {
    const rem = n % 26;
    chars.push(String.fromCharCode(65 + rem));
    n = Math.floor(n / 26);
    if (n === 0) break;
    n -= 1;
  }
  return chars.reverse().join("");
}
