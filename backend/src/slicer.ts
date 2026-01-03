/**
 * Slicer - Extracts row slices from a large file using the sparse index.
 * 
 * Given a row range (startRow, rowCount), this module:
 * 1. Looks up the nearest index entry to find the byte offset
 * 2. Reads a portion of the file starting at that offset
 * 3. Scans forward to find the exact starting row
 * 4. Parses the requested rows
 * 5. Returns the parsed cell data
 */

import { type FileIndex, type SliceResponse, TOTAL_COLS, COL_LETTERS } from "./types";

const NEWLINE = 0x0a; // '\n'
const SEMICOLON = 0x3b; // ';'

// Read buffer size - enough for ~1000 rows of typical data
const READ_BUFFER_SIZE = 32 * 1024; // 32KB

/**
 * Slice manager that holds the file handle and index.
 */
export class Slicer {
  private file: ReturnType<typeof Bun.file>;
  private fileSize: number;
  private index: FileIndex;
  
  constructor(filePath: string, index: FileIndex) {
    this.file = Bun.file(filePath);
    this.fileSize = this.file.size;
    this.index = index;
  }
  
  /**
   * Get a slice of rows from the file.
   * 
   * @param startRow - First row to return (0-indexed)
   * @param rowCount - Number of rows to return
   * @param startCol - First column to return (0-indexed)
   * @param colCount - Number of columns to return
   */
  async getSlice(
    startRow: number,
    rowCount: number,
    startCol: number,
    colCount: number
  ): Promise<SliceResponse> {
    // Clamp to valid ranges
    startRow = Math.max(0, Math.min(startRow, this.index.totalRows - 1));
    rowCount = Math.min(rowCount, this.index.totalRows - startRow);
    startCol = Math.max(0, Math.min(startCol, TOTAL_COLS - 1));
    colCount = Math.min(colCount, TOTAL_COLS - startCol);
    
    if (rowCount <= 0) {
      return {
        type: "slice_response",
        startRow,
        rowCount: 0,
        startCol,
        colCount,
        colLetters: COL_LETTERS.slice(startCol, startCol + colCount),
        cellsByRow: [],
      };
    }
    
    // Find the index entry at or before startRow
    const indexEntry = Math.floor(startRow / this.index.granularity);
    const indexOffset = this.index.offsets[indexEntry];
    const rowsToSkip = startRow - (indexEntry * this.index.granularity);
    
    // Calculate how many bytes we might need to read
    // Estimate ~20 bytes per row (city name + semicolon + temp + newline)
    const estimatedBytesNeeded = (rowsToSkip + rowCount) * 30;
    const bytesToRead = Math.min(
      Math.max(estimatedBytesNeeded, READ_BUFFER_SIZE),
      this.fileSize - Number(indexOffset)
    );
    
    // Read the chunk from file
    const chunk = await this.readBytes(Number(indexOffset), bytesToRead);
    
    // Parse rows from the chunk
    const rows = this.parseRows(chunk, rowsToSkip, rowCount, startCol, colCount);
    
    // If we didn't get enough rows, we need to read more
    // (This can happen if rows are longer than expected)
    if (rows.length < rowCount && startRow + rows.length < this.index.totalRows) {
      // Read more data and try again
      const additionalBytesNeeded = (rowCount - rows.length) * 50;
      const newBytesToRead = Math.min(
        bytesToRead + additionalBytesNeeded,
        this.fileSize - Number(indexOffset)
      );
      
      if (newBytesToRead > bytesToRead) {
        const largerChunk = await this.readBytes(Number(indexOffset), newBytesToRead);
        const moreRows = this.parseRows(largerChunk, rowsToSkip, rowCount, startCol, colCount);
        return {
          type: "slice_response",
          startRow,
          rowCount: moreRows.length,
          startCol,
          colCount,
          colLetters: COL_LETTERS.slice(startCol, startCol + colCount),
          cellsByRow: moreRows,
        };
      }
    }
    
    return {
      type: "slice_response",
      startRow,
      rowCount: rows.length,
      startCol,
      colCount,
      colLetters: COL_LETTERS.slice(startCol, startCol + colCount),
      cellsByRow: rows,
    };
  }
  
  /**
   * Read bytes from the file at a specific offset.
   */
  private async readBytes(offset: number, length: number): Promise<Uint8Array> {
    const slice = this.file.slice(offset, offset + length);
    const buffer = await slice.arrayBuffer();
    return new Uint8Array(buffer);
  }
  
  /**
   * Parse rows from a byte buffer.
   * 
   * @param data - Raw bytes from the file
   * @param skipRows - Number of complete rows to skip
   * @param maxRows - Maximum number of rows to return
   * @param startCol - First column to include
   * @param colCount - Number of columns to include
   */
  private parseRows(
    data: Uint8Array,
    skipRows: number,
    maxRows: number,
    startCol: number,
    colCount: number
  ): string[][] {
    const decoder = new TextDecoder();
    const rows: string[][] = [];
    
    let pos = 0;
    let rowsSkipped = 0;
    
    // Skip initial rows
    while (pos < data.length && rowsSkipped < skipRows) {
      if (data[pos] === NEWLINE) {
        rowsSkipped++;
      }
      pos++;
    }
    
    // Parse requested rows
    while (pos < data.length && rows.length < maxRows) {
      // Find the end of this line
      let lineEnd = pos;
      while (lineEnd < data.length && data[lineEnd] !== NEWLINE) {
        lineEnd++;
      }
      
      if (lineEnd === pos) {
        // Empty line, skip
        pos = lineEnd + 1;
        continue;
      }
      
      // Parse the line: "City;Temperature"
      const lineBytes = data.subarray(pos, lineEnd);
      const line = decoder.decode(lineBytes);
      
      // Split by semicolon
      const semicolonIdx = line.indexOf(";");
      let cells: string[];
      
      if (semicolonIdx === -1) {
        // No semicolon found, treat whole line as single cell
        cells = [line, ""];
      } else {
        cells = [
          line.substring(0, semicolonIdx),
          line.substring(semicolonIdx + 1),
        ];
      }
      
      // Slice columns as requested
      const slicedCells = cells.slice(startCol, startCol + colCount);
      
      // Pad with empty strings if needed
      while (slicedCells.length < colCount) {
        slicedCells.push("");
      }
      
      rows.push(slicedCells);
      pos = lineEnd + 1;
    }
    
    return rows;
  }
  
  /**
   * Get the total row count.
   */
  getTotalRows(): number {
    return this.index.totalRows;
  }
}

/**
 * Compute which rows/columns to fetch based on viewport parameters.
 * This mirrors the frontend's computeWindow function.
 */
export function computeSliceParams(params: {
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
}): {
  startRow: number;
  rowCount: number;
  startCol: number;
  colCount: number;
} {
  const {
    screenWidth,
    screenHeight,
    horizontalBuffer,
    verticalBuffer,
    defaultColumnWidth,
    defaultRowHeight,
    scrollLeft,
    scrollTop,
    maxRows,
    maxCols,
  } = params;
  
  // Calculate visible rows
  const startRow = Math.floor(scrollTop / defaultRowHeight);
  const visibleRows = Math.ceil(screenHeight / defaultRowHeight);
  let rowCount = visibleRows + (verticalBuffer * 2);
  
  // Clamp to valid range
  const remainingRows = maxRows - startRow;
  if (rowCount > remainingRows) {
    rowCount = remainingRows;
  }
  
  // Calculate visible columns
  const startCol = Math.floor(scrollLeft / defaultColumnWidth);
  const visibleCols = Math.ceil(screenWidth / defaultColumnWidth);
  let colCount = visibleCols + (horizontalBuffer * 2);
  
  // Clamp to valid range
  const remainingCols = maxCols - startCol;
  if (colCount > remainingCols) {
    colCount = remainingCols;
  }
  
  // Safety caps
  rowCount = Math.min(rowCount, 1000);
  colCount = Math.min(colCount, 200);
  
  return {
    startRow: Math.max(0, startRow),
    rowCount: Math.max(0, rowCount),
    startCol: Math.max(0, startCol),
    colCount: Math.max(0, colCount),
  };
}
