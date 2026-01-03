/**
 * Indexer - Builds a sparse row offset index for fast random access to large CSV files.
 * 
 * The index maps row numbers to byte offsets in the file:
 * - Row 0      -> byte 0
 * - Row 10000  -> byte X
 * - Row 20000  -> byte Y
 * - ...
 * 
 * This allows O(1) lookup of the approximate byte offset for any row,
 * followed by a small linear scan to find the exact row.
 */

import { type FileIndex, type Config, DEFAULT_CONFIG } from "./types";

const NEWLINE = 0x0a; // '\n'
const CHUNK_SIZE = 64 * 1024 * 1024; // 64MB chunks for reading

/**
 * Build a sparse index of row byte offsets.
 * 
 * Scans the entire file once, recording the byte offset of every Nth row
 * (where N = granularity).
 * 
 * For a 13.8GB file with 1 billion rows:
 * - Time: ~30-60 seconds (depending on disk speed / page cache)
 * - Memory: 800KB for the index (with granularity=10000)
 */
export async function buildIndex(config: Config = DEFAULT_CONFIG): Promise<FileIndex> {
  const file = Bun.file(config.filePath);
  const fileSize = file.size;
  const granularity = config.indexGranularity;
  
  console.log(`[indexer] Building index for ${config.filePath}`);
  console.log(`[indexer] File size: ${(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`[indexer] Granularity: every ${granularity.toLocaleString()} rows`);
  
  const startTime = performance.now();
  
  // Estimate max index entries (assuming avg row length of 15 bytes)
  const estimatedRows = Math.ceil(fileSize / 15);
  const estimatedEntries = Math.ceil(estimatedRows / granularity) + 1;
  
  // Pre-allocate offset array
  const offsets: bigint[] = [0n]; // Row 0 is always at byte 0
  
  let totalRows = 0;
  let currentOffset = 0n;
  let rowsSinceLastIndex = 0;
  let lastLoggedGB = -1;
  
  // Read file in chunks
  const stream = file.stream();
  const reader = stream.getReader();
  
  let done = false;
  while (!done) {
    const result = await reader.read();
    done = result.done;
    
    if (result.value) {
      const chunk = result.value;
      
      // Scan for newlines in this chunk
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === NEWLINE) {
          totalRows++;
          rowsSinceLastIndex++;
          
          // Record offset at granularity boundaries
          if (rowsSinceLastIndex >= granularity) {
            // Offset of the NEXT row (byte after newline)
            offsets.push(currentOffset + BigInt(i) + 1n);
            rowsSinceLastIndex = 0;
          }
        }
      }
      
      currentOffset += BigInt(chunk.length);
    }
    
    // Progress logging every ~1GB (only once per GB)
    const currentGB = Math.floor(Number(currentOffset) / (1024 * 1024 * 1024));
    if (currentGB > lastLoggedGB) {
      lastLoggedGB = currentGB;
      const progress = (Number(currentOffset) / fileSize) * 100;
      console.log(`[indexer] Progress: ${progress.toFixed(1)}% (${totalRows.toLocaleString()} rows)`);
    }
  }
  
  const elapsed = (performance.now() - startTime) / 1000;
  console.log(`[indexer] Completed in ${elapsed.toFixed(2)}s`);
  console.log(`[indexer] Total rows: ${totalRows.toLocaleString()}`);
  console.log(`[indexer] Index entries: ${offsets.length.toLocaleString()}`);
  console.log(`[indexer] Index size: ${(offsets.length * 8 / 1024).toFixed(1)} KB`);
  
  // Convert to BigUint64Array for efficient storage
  const offsetArray = new BigUint64Array(offsets);
  
  return {
    totalRows,
    offsets: offsetArray,
    granularity,
  };
}

/**
 * Save index to disk for faster startup next time.
 */
export async function saveIndex(index: FileIndex, path: string): Promise<void> {
  console.log(`[indexer] Saving index to ${path}`);
  
  // Format: [totalRows: u64][granularity: u64][offsets: u64[]]
  const headerSize = 16; // 2 × 8 bytes
  const buffer = new ArrayBuffer(headerSize + index.offsets.byteLength);
  const view = new DataView(buffer);
  
  // Write header
  view.setBigUint64(0, BigInt(index.totalRows), true); // little-endian
  view.setBigUint64(8, BigInt(index.granularity), true);
  
  // Write offsets
  const offsetBytes = new Uint8Array(buffer, headerSize);
  offsetBytes.set(new Uint8Array(index.offsets.buffer));
  
  await Bun.write(path, buffer);
  console.log(`[indexer] Index saved (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
}

/**
 * Load index from disk.
 */
export async function loadIndex(path: string): Promise<FileIndex | null> {
  const file = Bun.file(path);
  
  if (!(await file.exists())) {
    console.log(`[indexer] No cached index found at ${path}`);
    return null;
  }
  
  console.log(`[indexer] Loading cached index from ${path}`);
  const startTime = performance.now();
  
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  
  // Read header
  const totalRows = Number(view.getBigUint64(0, true));
  const granularity = Number(view.getBigUint64(8, true));
  
  // Read offsets
  const offsetBuffer = buffer.slice(16);
  const offsets = new BigUint64Array(offsetBuffer);
  
  const elapsed = (performance.now() - startTime);
  console.log(`[indexer] Index loaded in ${elapsed.toFixed(1)}ms`);
  console.log(`[indexer] Total rows: ${totalRows.toLocaleString()}`);
  console.log(`[indexer] Index entries: ${offsets.length.toLocaleString()}`);
  
  return {
    totalRows,
    offsets,
    granularity,
  };
}

/**
 * Get or build index, using cached version if available.
 */
export async function getOrBuildIndex(config: Config = DEFAULT_CONFIG): Promise<FileIndex> {
  // Try to load cached index first
  if (config.indexPath) {
    const cached = await loadIndex(config.indexPath);
    if (cached) {
      // Verify it matches the current file (check if totalRows is reasonable)
      const file = Bun.file(config.filePath);
      const expectedMinRows = Math.floor(file.size / 50); // Assume max 50 bytes per row
      const expectedMaxRows = Math.ceil(file.size / 5);   // Assume min 5 bytes per row
      
      if (cached.totalRows >= expectedMinRows && cached.totalRows <= expectedMaxRows) {
        return cached;
      }
      console.log(`[indexer] Cached index seems stale, rebuilding...`);
    }
  }
  
  // Build fresh index
  const index = await buildIndex(config);
  
  // Save for next time
  if (config.indexPath) {
    await saveIndex(index, config.indexPath);
  }
  
  return index;
}
