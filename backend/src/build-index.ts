/**
 * Standalone script to pre-build the row index.
 * 
 * Run this once after placing a new measurements.txt file:
 *   bun run build-index
 * 
 * This will create a .idx file that the server can load instantly on startup,
 * instead of scanning the entire 13.8GB file.
 */

import { buildIndex, saveIndex } from "./indexer";
import { DEFAULT_CONFIG } from "./types";

console.log("=".repeat(60));
console.log("1BR Index Builder");
console.log("=".repeat(60));
console.log();

const startTime = performance.now();

// Build the index
const index = await buildIndex(DEFAULT_CONFIG);

// Save to disk
if (DEFAULT_CONFIG.indexPath) {
  await saveIndex(index, DEFAULT_CONFIG.indexPath);
}

const totalTime = ((performance.now() - startTime) / 1000).toFixed(2);
console.log();
console.log(`Total time: ${totalTime}s`);
console.log("Done!");
