//! Minimal stdio MCP server (`--mcp`).
//!
//! Implements the Model Context Protocol transport used by local agents:
//! newline-delimited JSON-RPC 2.0 over stdin/stdout. It exposes `info` and
//! `convert`, reusing the same converter and JSON payloads as the CLI. No
//! network access is performed and human output is redirected to stderr.

use std::io::{self, BufRead, Write};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::{Value, json};

use crate::convert::{self, ConvertResult, FileError, Summary};
use crate::paths;
use crate::report;
use crate::settings::{self, Settings};
use crate::{discovery, ui};

const PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_VERSIONS: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

/// Serve MCP requests until stdin closes.
pub fn serve() -> anyhow::Result<()> {
    // Human output from the converter must never reach the protocol stream.
    ui::set_json_mode(true);
    convert::CANCEL_REQUESTED.store(false, std::sync::atomic::Ordering::SeqCst);

    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_line(&line) {
            serde_json::to_writer(&mut stdout, &response)?;
            stdout.write_all(b"\n")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

fn handle_line(line: &str) -> Option<Value> {
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            return Some(json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32700, "message": format!("Parse error: {error}") }
            }));
        }
    };

    let id = request.get("id").cloned();
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return id.map(|id| {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32600, "message": "Invalid Request" }
            })
        });
    };

    match method {
        "initialize" => {
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            let requested = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let version = if SUPPORTED_VERSIONS.contains(&requested) {
                requested
            } else {
                PROTOCOL_VERSION
            };
            Some(ok(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": {
                        "name": "pictowebp",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "instructions": "Convert JPEG/PNG/WebP images locally. Call info first, then convert with an explicit source and output_dir. Runs never prompt or touch the network."
                }),
            ))
        }
        "notifications/initialized" | "notifications/cancelled" => None,
        "ping" => Some(ok(id, json!({}))),
        "tools/list" => Some(ok(id, tools_list())),
        "tools/call" => Some(ok(
            id,
            call_tool(request.get("params").cloned().unwrap_or(Value::Null)),
        )),
        "resources/list" => Some(ok(id, json!({ "resources": [] }))),
        "prompts/list" => Some(ok(id, json!({ "prompts": [] }))),
        "logging/setLevel" => Some(ok(id, json!({}))),
        "shutdown" => Some(ok(id, Value::Null)),
        other => id.map(|id| {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Unknown method: {other}") }
            })
        }),
    }
}

fn ok(id: Option<Value>, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": result
    })
}

fn tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "info",
                "title": "Tool information",
                "description": "Return edition, version, target and capabilities. No conversion.",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                },
                "annotations": {
                    "readOnlyHint": true,
                    "destructiveHint": false,
                    "idempotentHint": true,
                    "openWorldHint": false
                }
            },
            {
                "name": "convert",
                "title": "Convert images to WebP",
                "description": "Convert a folder or a single image. Never prompts and never touches the network.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "source": { "type": "string", "description": "Folder or image path." },
                        "output_dir": {
                            "type": ["string", "null"],
                            "description": "Empty or missing destination folder. Omit for a sibling folder."
                        },
                        "quality": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 100,
                            "default": 80
                        },
                        "lossless": { "type": "boolean", "default": false },
                        "keep_metadata": { "type": "boolean", "default": false },
                        "dry_run": { "type": "boolean", "default": false },
                        "threads": {
                            "type": ["integer", "null"],
                            "minimum": 1,
                            "maximum": 256
                        },
                        "max_pixels": {
                            "type": ["integer", "null"],
                            "minimum": 1
                        }
                    },
                    "required": ["source"],
                    "additionalProperties": false
                },
                "annotations": {
                    "readOnlyHint": false,
                    "destructiveHint": false,
                    "idempotentHint": false,
                    "openWorldHint": false
                }
            }
        ]
    })
}

fn call_tool(params: Value) -> Value {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let empty = json!({});
    let arguments = params.get("arguments").unwrap_or(&empty);
    match name {
        "info" => tool_result(json_value(&report::info_json())),
        "convert" => convert_tool(arguments),
        other => tool_error(&format!("Unknown tool: {other}")),
    }
}

fn convert_tool(arguments: &Value) -> Value {
    let Some(source) = arguments
        .get("source")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
    else {
        return tool_error("source is required");
    };

    let quality = match arguments.get("quality") {
        Some(value) => match value.as_u64().and_then(|value| u8::try_from(value).ok()) {
            Some(value) if (1..=100).contains(&value) => value,
            _ => return tool_error("quality must be an integer between 1 and 100"),
        },
        None => settings::DEFAULT_QUALITY,
    };

    let threads = match arguments.get("threads") {
        Some(Value::Null) | None => default_threads(),
        Some(value) => match value.as_u64() {
            Some(value) if (1..=settings::MAX_THREADS as u64).contains(&value) => value as usize,
            _ => {
                return tool_error(&format!(
                    "threads must be an integer between 1 and {}",
                    settings::MAX_THREADS
                ));
            }
        },
    };
    let Some(threads) = NonZeroUsize::new(threads) else {
        return tool_error("threads must be a positive integer");
    };

    let max_pixels = match arguments.get("max_pixels") {
        Some(Value::Null) | None => env_max_pixels(),
        Some(value) => match value.as_u64() {
            Some(value) if value > 0 => value,
            _ => return tool_error("max_pixels must be a positive integer"),
        },
    };

    let lossless = arguments
        .get("lossless")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let keep_metadata = arguments
        .get("keep_metadata")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let dry_run = arguments
        .get("dry_run")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let output_dir = arguments
        .get("output_dir")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);

    let source_path = PathBuf::from(&source);
    if !source_path.exists() {
        return tool_error(&format!(
            "Source path does not exist: {}",
            source_path.display()
        ));
    }
    let single_file = source_path.is_file();
    if !single_file && !source_path.is_dir() {
        return tool_error(&format!(
            "Source path is neither a folder nor a file: {}",
            source_path.display()
        ));
    }
    let source_root = if single_file {
        source_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default()
    } else {
        source_path.clone()
    };

    let settings = Settings {
        source: source_path.clone(),
        source_root: source_root.clone(),
        single_file,
        quality,
        threads,
        max_pixels,
        lossless,
        strip_metadata: !keep_metadata,
        no_progress: true,
        report_path: None,
        allow_report_outside: false,
        output_dir: output_dir.clone(),
        dry_run,
        json: true,
        fail_on_error: false,
        fail_on_empty: false,
    };

    let files = if single_file {
        vec![source_path.clone()]
    } else {
        discovery::discover_images(&source_path)
    };
    let discovered = files.len();
    if files.is_empty() {
        let result = ConvertResult::default();
        return tool_result(json_value(&report::result_json(
            &settings, &result, None, discovered, 0, false, None,
        )));
    }

    let output_folder = match paths::resolve_output_folder(
        &source_root,
        settings.output_dir.as_deref(),
        single_file,
        dry_run,
    ) {
        Ok(folder) => folder,
        Err(error) => return tool_error(&format!("{error:#}")),
    };

    let existing_output = if single_file {
        output_folder.as_ref().and_then(|folder| {
            let name = source_path
                .file_name()
                .unwrap_or_else(|| std::ffi::OsStr::new("image"));
            let destination = folder.join(name).with_extension("webp");
            destination.exists().then_some(destination)
        })
    } else {
        None
    };

    let started = Instant::now();
    let result = if let Some(destination) = existing_output {
        ConvertResult {
            summary: Summary {
                failed_files: 1,
                ..Default::default()
            },
            file_errors: vec![FileError {
                path: source_path.clone(),
                category: "Output file already exists",
                message: format!(
                    "Refusing to overwrite {}. Remove it or choose a different output_dir.",
                    destination.display()
                ),
            }],
        }
    } else if dry_run {
        convert::preview(&files, &source_root, single_file)
    } else {
        convert::convert_all(
            &files,
            &settings,
            output_folder.as_deref().unwrap(),
            indicatif::ProgressBar::hidden(),
        )
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;

    let report = if dry_run {
        None
    } else {
        let report_base = if single_file {
            None
        } else {
            output_folder.as_deref()
        };
        convert::write_error_report(report_base, &result.file_errors, None).unwrap_or(None)
    };

    tool_result(json_value(&report::result_json(
        &settings,
        &result,
        output_folder.as_deref(),
        discovered,
        elapsed_ms,
        false,
        report.as_deref(),
    )))
}

fn default_threads() -> usize {
    std::thread::available_parallelism()
        .map(NonZeroUsize::get)
        .unwrap_or(16)
        .min(settings::MAX_THREADS)
}

fn env_max_pixels() -> u64 {
    std::env::var("PICTOWEBP_MAX_PIXELS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(settings::DEFAULT_MAX_PIXELS)
}

fn json_value(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|error| {
        json!({
            "schema": "pictowebp.error/v1",
            "error": format!("could not serialize payload: {error}")
        })
    })
}

fn tool_result(value: Value) -> Value {
    let text = value.to_string();
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": value,
        "isError": false
    })
}

fn tool_error(message: &str) -> Value {
    let value = json!({
        "schema": "pictowebp.error/v1",
        "error": message
    });
    json!({
        "content": [{ "type": "text", "text": value.to_string() }],
        "structuredContent": value,
        "isError": true
    })
}
