use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SliceRequest {
    screen_width: u32,
    screen_height: u32,
    horizontal_buffer: u32,
    vertical_buffer: u32,
    default_column_width: u32,
    default_row_height: u32,
    scroll_left: u64,
    scroll_top: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SliceResponse {
    r#type: &'static str,
    start_row: u64,
    row_count: u32,
    start_col: u32,
    col_count: u32,
    col_letters: Vec<String>,
    cells_by_row: Vec<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataResponse {
    r#type: &'static str,
    max_rows: u64,
    max_cols: u32,
}

const SERVER_MAX_ROWS: u64 = 10_000_000;
const SERVER_MAX_COLS: u32 = 1_000;

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let app = Router::new().route("/ws", get(ws_handler));

    let addr = "127.0.0.1:4001";
    let listener = TcpListener::bind(addr).await.expect("bind ws listener");
    tracing::info!("WebSocket server listening on ws://{}{}", addr, "/ws");
    axum::serve(listener, app).await.expect("serve axum");
}

async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    // Axum 0.7 does not expose a direct API to select permessage-deflate here.
    // However, most browsers will negotiate permessage-deflate automatically if
    // the server's tungstenite backend is built with compression (Axum enables it internally).
    // We also raise frame/message limits.
    ws.max_message_size(16 * 1024 * 1024)
        .max_frame_size(16 * 1024 * 1024)
        .on_upgrade(handle_socket)
}

async fn handle_socket(mut socket: WebSocket) {
    while let Some(msg_result) = socket.recv().await {
        match msg_result {
            Ok(Message::Text(txt)) => {
                match serde_json::from_str::<serde_json::Value>(&txt) {
                    Ok(val) => {
                        let msg_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        match msg_type {
                            "metadata_request" => {
                                let resp = MetadataResponse {
                                    r#type: "metadata_response",
                                    max_rows: SERVER_MAX_ROWS,
                                    max_cols: SERVER_MAX_COLS,
                                };
                                let _ = socket
                                    .send(Message::Text(
                                        serde_json::to_string(&resp).unwrap(),
                                    ))
                                    .await;
                            }
                            "slice_request" => {
                                match serde_json::from_value::<SliceRequest>(val) {
                                    Ok(req) => {
                                        let resp = make_slice_response(&req);
                                        let _ = socket
                                            .send(Message::Text(
                                                serde_json::to_string(&resp).unwrap(),
                                            ))
                                            .await;
                                    }
                                    Err(err) => {
                                        let _ = socket
                                            .send(Message::Text(format!(
                                                "{{\"type\":\"error\",\"message\":\"bad request: {}\"}}",
                                                err
                                            )))
                                            .await;
                                    }
                                }
                            }
                            _ => {
                                let _ = socket
                                    .send(Message::Text(
                                        "{\"type\":\"error\",\"message\":\"unknown message type\"}".to_string(),
                                    ))
                                    .await;
                            }
                        }
                    }
                    Err(_) => {
                        let _ = socket
                            .send(Message::Text(
                                "{\"type\":\"error\",\"message\":\"invalid json\"}".to_string(),
                            ))
                            .await;
                    }
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

fn make_slice_response(req: &SliceRequest) -> SliceResponse {
    let start_row = (req.scroll_top / req.default_row_height as u64) as u64;
    let visible_rows = div_ceil(req.screen_height, req.default_row_height);
    let mut row_count_u64 = visible_rows as u64
        + (req.vertical_buffer as u64 * 2);
    let remaining_rows = SERVER_MAX_ROWS.saturating_sub(start_row);
    if row_count_u64 > remaining_rows {
        row_count_u64 = remaining_rows;
    }
    let row_count = row_count_u64 as u32;

    let start_col = (req.scroll_left / req.default_column_width as u64) as u32;
    let visible_cols = div_ceil(req.screen_width, req.default_column_width);
    let mut col_count = visible_cols + (req.horizontal_buffer * 2);
    let remaining_cols = SERVER_MAX_COLS.saturating_sub(start_col);
    if col_count > remaining_cols {
        col_count = remaining_cols;
    }

    // Safety caps for PoC
    let row_count = row_count.min(1000);
    let col_count = col_count.min(200);

    let mut col_letters = Vec::with_capacity(col_count as usize);
    for c in start_col..start_col + col_count {
        col_letters.push(col_index_to_letters(c));
    }

    let mut cells_by_row: Vec<Vec<String>> = Vec::with_capacity(row_count as usize);
    for r in 0..row_count as u64 {
        let mut row: Vec<String> = Vec::with_capacity(col_count as usize);
        for c in 0..col_count {
            let label = &col_letters[c as usize];
            row.push(format!("R{}C {}", start_row + r + 1, label));
        }
        cells_by_row.push(row);
    }

    SliceResponse {
        r#type: "slice_response",
        start_row,
        row_count,
        start_col,
        col_count,
        col_letters,
        cells_by_row,
    }
}

fn div_ceil(a: u32, b: u32) -> u32 {
    if b == 0 { return 0; }
    (a + b - 1) / b
}

fn col_index_to_letters(mut index: u32) -> String {
    // 0 -> A, 25 -> Z, 26 -> AA, 27 -> AB, ...
    let mut chars: Vec<char> = Vec::new();
    loop {
        let rem = index % 26;
        chars.push((b'A' + (rem as u8)) as char);
        index /= 26;
        if index == 0 {
            break;
        }
        index -= 1; // carry adjustment for 1-based alphabetic sequence
    }
    chars.iter().rev().collect()
}
