// ============================================================================
// WebSocket Message Types
// ============================================================================

// Client -> Server messages
export interface MetadataRequest {
  type: "metadata_request";
}

export interface SliceRequest {
  type: "slice_request";
  screenWidth: number;
  screenHeight: number;
  horizontalBuffer: number;
  verticalBuffer: number;
  defaultColumnWidth: number;
  defaultRowHeight: number;
  scrollLeft: number;
  scrollTop: number;
}

export type ClientMessage = MetadataRequest | SliceRequest;

// Server -> Client messages
export interface MetadataResponse {
  type: "metadata_response";
  maxRows: number;
  maxCols: number;
}

export interface SliceResponse {
  type: "slice_response";
  startRow: number;
  rowCount: number;
  startCol: number;
  colCount: number;
  colLetters: string[];
  cellsByRow: string[][];
}

export interface ErrorResponse {
  type: "error";
  message: string;
}

export type ServerMessage = MetadataResponse | SliceResponse | ErrorResponse;

// ============================================================================
// Index Types
// ============================================================================

/**
 * Sparse index for fast row lookups in large files.
 * 
 * For a 1 billion row file with INDEX_GRANULARITY=1000:
 * - 1,000,000 index entries
 * - Each entry is 8 bytes (BigUint64)
 * - Total: ~8MB in memory
 * 
 * To find row N:
 * 1. Look up index[floor(N / INDEX_GRANULARITY)] to get byte offset
 * 2. Seek to that offset
 * 3. Scan forward (N % INDEX_GRANULARITY) rows
 */
export interface FileIndex {
  /** Total number of rows in the file */
  totalRows: number;
  
  /** Byte offsets for every INDEX_GRANULARITY rows */
  offsets: BigUint64Array;
  
  /** How many rows between each index entry */
  granularity: number;
}

// ============================================================================
// Configuration
// ============================================================================

export interface Config {
  /** Path to the measurements file */
  filePath: string;
  
  /** WebSocket server port */
  port: number;
  
  /** Number of rows between each index entry */
  indexGranularity: number;
  
  /** Path to persist the index file (optional) */
  indexPath?: string;
}

export const DEFAULT_CONFIG: Config = {
  filePath: process.env.MEASUREMENTS_FILE ?? "/Users/taekim/Documents/projects/_sideprojects/1br-tae/measurements.txt",
  port: parseInt(process.env.PORT ?? "4001", 10),
  indexGranularity: 1_000,
  indexPath: process.env.INDEX_FILE ?? "/Users/taekim/Documents/projects/_sideprojects/1br-frontend/backend/measurements.idx",
};

// ============================================================================
// Constants
// ============================================================================

/** Number of columns in measurements.txt (City;Temperature) */
export const TOTAL_COLS = 2;

/** Column headers */
export const COL_LETTERS = ["A", "B"];
export const COL_HEADERS = ["City", "Temperature"];
