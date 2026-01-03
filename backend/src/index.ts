/**
 * 1BR Backend - Bun WebSocket Server
 * 
 * High-performance spreadsheet data server that serves slices of a 1 billion row
 * dataset to a virtual-scrolling frontend.
 * 
 * Architecture:
 * 1. On startup: Build/load sparse row index for fast random access
 * 2. On WebSocket connection: Handle metadata and slice requests
 * 3. On slice request: Use index to seek to row, parse, return data
 */

import { getOrBuildIndex } from "./indexer";
import { Slicer, computeSliceParams } from "./slicer";
import {
  type ClientMessage,
  type MetadataResponse,
  type SliceRequest,
  type ErrorResponse,
  DEFAULT_CONFIG,
  TOTAL_COLS,
} from "./types";

// ============================================================================
// Initialization
// ============================================================================

console.log("=".repeat(60));
console.log("1BR Backend - Bun WebSocket Server");
console.log("=".repeat(60));

// Build or load the file index
console.log("\n[startup] Initializing file index...\n");
const index = await getOrBuildIndex(DEFAULT_CONFIG);

// Create the slicer
const slicer = new Slicer(DEFAULT_CONFIG.filePath, index);

console.log("\n[startup] Server ready!");
console.log(`[startup] Total rows: ${index.totalRows.toLocaleString()}`);
console.log(`[startup] Total cols: ${TOTAL_COLS}`);

// ============================================================================
// WebSocket Server
// ============================================================================

const server = Bun.serve({
  port: DEFAULT_CONFIG.port,
  
  fetch(req, server) {
    const url = new URL(req.url);
    
    // Handle WebSocket upgrade on /ws
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (upgraded) {
        return undefined;
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    
    // Health check endpoint
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        totalRows: index.totalRows,
        totalCols: TOTAL_COLS,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    
    return new Response("Not Found", { status: 404 });
  },
  
  websocket: {
    open(ws) {
      console.log(`[ws] Client connected`);
    },
    
    close(ws) {
      console.log(`[ws] Client disconnected`);
    },
    
    async message(ws, message) {
      try {
        // Parse incoming message
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        const msg = JSON.parse(text) as ClientMessage;
        
        switch (msg.type) {
          case "metadata_request": {
            const response: MetadataResponse = {
              type: "metadata_response",
              maxRows: index.totalRows,
              maxCols: TOTAL_COLS,
            };
            ws.send(JSON.stringify(response));
            break;
          }
          
          case "slice_request": {
            const startTime = performance.now();
            
            // Compute slice parameters from viewport info
            const sliceParams = computeSliceParams({
              screenWidth: msg.screenWidth,
              screenHeight: msg.screenHeight,
              horizontalBuffer: msg.horizontalBuffer,
              verticalBuffer: msg.verticalBuffer,
              defaultColumnWidth: msg.defaultColumnWidth,
              defaultRowHeight: msg.defaultRowHeight,
              scrollLeft: msg.scrollLeft,
              scrollTop: msg.scrollTop,
              maxRows: index.totalRows,
              maxCols: TOTAL_COLS,
            });
            
            // Get the slice from the file
            const response = await slicer.getSlice(
              sliceParams.startRow,
              sliceParams.rowCount,
              sliceParams.startCol,
              sliceParams.colCount
            );
            
            const elapsed = (performance.now() - startTime).toFixed(2);
            console.log(
              `[ws] slice_request: rows ${sliceParams.startRow}-${sliceParams.startRow + sliceParams.rowCount} ` +
              `(${response.cellsByRow.length} rows returned) in ${elapsed}ms`
            );
            
            ws.send(JSON.stringify(response));
            break;
          }
          
          default: {
            const error: ErrorResponse = {
              type: "error",
              message: `Unknown message type: ${(msg as any).type}`,
            };
            ws.send(JSON.stringify(error));
          }
        }
      } catch (err) {
        console.error("[ws] Error processing message:", err);
        const error: ErrorResponse = {
          type: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        };
        ws.send(JSON.stringify(error));
      }
    },
  },
});

console.log(`\n[server] WebSocket server listening on ws://localhost:${DEFAULT_CONFIG.port}/ws`);
console.log(`[server] Health check: http://localhost:${DEFAULT_CONFIG.port}/health\n`);
