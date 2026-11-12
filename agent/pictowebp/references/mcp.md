# MCP server

Rust CLI **0.4.0+** can run as a local stdio
[Model Context Protocol](https://modelcontextprotocol.io) server:

```bash
pictowebp --mcp
```

Properties:

- transport: stdio, newline-delimited JSON-RPC 2.0
- tools: `info` (read-only) and `convert`
- no network access, no prompts, no analytics
- human output goes to stderr; stdout carries only protocol messages
- the result, info and error payloads are the same `pictowebp.*/v1` schemas as
  the CLI (see `schemas/`)

## `convert`

| Argument | Type | Notes |
|---|---|---|
| `source` | string | Folder or single image path. Required. |
| `output_dir` | string \| null | Empty or missing folder. Omit for a sibling folder. |
| `quality` | integer | 1–100, default 80. Ignored by `lossless`. |
| `lossless` | boolean | Default false. |
| `keep_metadata` | boolean | Default false; EXIF/GPS is stripped. |
| `dry_run` | boolean | Count and detect collisions without writing. |
| `threads` | integer \| null | 1–256. |
| `max_pixels` | integer \| null | Decoded-pixel cap per image. |

The tool returns the `pictowebp.result/v1` object as `structuredContent` and
as a text content block. Partial failures are a normal result with `ok: false`;
invalid arguments or unusable paths return `pictowebp.error/v1` with
`isError: true`.

## Example

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"convert","arguments":{"source":"./public/images","output_dir":"./public/images-webp","quality":82}}}
```

Detect support with `pictowebp --info --json`: the `capabilities` array contains
`"mcp"` on binaries that expose `--mcp`.
