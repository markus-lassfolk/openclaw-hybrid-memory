#!/usr/bin/env python3
"""
MarkItDown JSON-RPC worker.

Reads JSON-RPC 2.0 requests from stdin (one per line) and writes responses
to stdout. Used by the TypeScript python-bridge service.

Supported methods:
  ping  — health check, returns {"pong": true}
  convert — convert a file URI to Markdown using markitdown
  shutdown — graceful exit
"""
import json
import sys
import os


def make_response(id, result):
    return {"jsonrpc": "2.0", "id": id, "result": result}


def make_error(id, code, message):
    return {"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}


def convert_file(uri: str):
    """Convert a file URI or path to Markdown via markitdown."""
    try:
        from markitdown import MarkItDown
    except ImportError:
        raise RuntimeError(
            "markitdown is not installed. Run: pip install markitdown"
        )

    # Accept both file:// URIs and plain paths
    if uri.startswith("file://"):
        path = uri[7:]
    else:
        path = uri

    if not os.path.exists(path):
        raise FileNotFoundError(f"File not found: {path}")

    md = MarkItDown()
    result = md.convert(path)
    markdown = result.text_content or ""
    title = getattr(result, "title", None) or os.path.basename(path)
    return {"markdown": markdown, "title": title}


def handle(request):
    req_id = request.get("id")
    method = request.get("method", "")
    params = request.get("params", {})

    if method == "ping":
        return make_response(req_id, {"pong": True})

    if method == "shutdown":
        return make_response(req_id, {"ok": True})

    if method == "convert":
        uri = params.get("uri", "")
        if not uri:
            return make_error(req_id, -32602, "params.uri is required")
        try:
            data = convert_file(uri)
            return make_response(req_id, data)
        except Exception as exc:
            return make_error(req_id, -32000, str(exc))

    return make_error(req_id, -32601, f"Method not found: {method}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            resp = make_error(None, -32700, f"Parse error: {exc}")
            print(json.dumps(resp), flush=True)
            continue

        resp = handle(request)
        print(json.dumps(resp), flush=True)

        # Exit cleanly on shutdown
        if request.get("method") == "shutdown":
            break


if __name__ == "__main__":
    main()
