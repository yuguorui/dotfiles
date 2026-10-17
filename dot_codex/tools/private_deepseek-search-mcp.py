#!/usr/bin/env python3
"""Minimal MCP stdio server for DeepSeek Search and Fetch APIs.

Endpoints:
  POST https://api.deepseek.com/v1/tools/search
  POST https://api.deepseek.com/v1/tools/fetch

Credentials are read from DEEPSEEK_API_KEY. The base URL can be overridden with
DEEPSEEK_SEARCH_BASE_URL (defaults to https://api.deepseek.com). Only the Python
standard library is used, so the server can run directly from ~/.codex/tools.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

SERVER_NAME = "deepseek-search"
SERVER_VERSION = "1.0.0"
DEFAULT_BASE_URL = "https://api.deepseek.com"
TIMEOUT_SECONDS = 60

TOOLS = [
    {
        "name": "search",
        "description": (
            "Search the web with DeepSeek's Search API. Returns ranked results "
            "with title, URL, snippet, long summary, optional page content, "
            "site metadata, date, and authority. Supports site:, -site:, "
            "exclusion, exact phrase, lang:, after:, and before: query operators."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query, 1-128 Unicode characters. Must not be all whitespace.",
                },
                "count": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 50,
                    "default": 10,
                    "description": "Number of results to return.",
                },
                "ori_question": {
                    "type": "string",
                    "description": "Optional original user question used to infer search intent, 1-128 characters.",
                },
                "localization": {
                    "type": "string",
                    "description": "Optional IP address used to prioritize localized results.",
                },
                "need_content": {
                    "type": "boolean",
                    "default": False,
                    "description": "Return the full page content in each result.",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "fetch",
        "description": (
            "Fetch one web page as Markdown with DeepSeek's Fetch API. "
            "Use this to read a URL found by search or supplied by the user."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "HTTP/HTTPS URL to fetch, up to 8192 characters, without embedded credentials.",
                }
            },
            "required": ["url"],
            "additionalProperties": False,
        },
    },
]


def _send(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _send_result(request_id: Any, result: Any) -> None:
    _send({"jsonrpc": "2.0", "id": request_id, "result": result})


def _send_error(request_id: Any, code: int, message: str) -> None:
    _send(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": code, "message": message},
        }
    )


def _base_url() -> str:
    value = os.environ.get("DEEPSEEK_SEARCH_BASE_URL") or DEFAULT_BASE_URL
    return value.rstrip("/")


def _api_key() -> str:
    value = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not value:
        raise RuntimeError("DEEPSEEK_API_KEY is not set in the MCP server environment")
    return value


def _post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        _base_url() + path,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + _api_key(),
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            message = json.loads(body)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            message = body[:2000] or exc.reason
        raise RuntimeError(f"DeepSeek API HTTP {exc.code}: {message}") from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"DeepSeek API request failed: {exc.reason}") from None


def _search(arguments: dict[str, Any]) -> dict[str, Any]:
    query = arguments.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query must be a non-empty string")

    count = arguments.get("count", 10)
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 50:
        raise ValueError("count must be an integer between 1 and 50")

    payload: dict[str, Any] = {"query": query, "count": count}
    for key in ("ori_question", "localization"):
        value = arguments.get(key)
        if value is not None:
            if not isinstance(value, str):
                raise ValueError(f"{key} must be a string")
            if value:
                payload[key] = value

    need_content = arguments.get("need_content", False)
    if not isinstance(need_content, bool):
        raise ValueError("need_content must be a boolean")
    payload["need_content"] = need_content
    return _post("/v1/tools/search", payload)


def _fetch(arguments: dict[str, Any]) -> dict[str, Any]:
    url = arguments.get("url")
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        raise ValueError("url must be an HTTP/HTTPS URL")
    return _post("/v1/tools/fetch", {"url": url})


def _call_tool(name: Any, arguments: Any) -> dict[str, Any]:
    if not isinstance(arguments, dict):
        raise ValueError("tool arguments must be an object")
    if name == "search":
        return _search(arguments)
    if name == "fetch":
        return _fetch(arguments)
    raise ValueError(f"unknown tool: {name!r}")


def _dispatch(message: dict[str, Any]) -> None:
    method = message.get("method")
    request_id = message.get("id")
    is_notification = "id" not in message

    if method == "initialize":
        params = message.get("params") or {}
        protocol_version = params.get("protocolVersion") or "2024-11-05"
        _send_result(
            request_id,
            {
                "protocolVersion": protocol_version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": (
                    "DeepSeek Search and Fetch. Use search for live web results; "
                    "use fetch to read a URL as Markdown."
                ),
            },
        )
    elif method in ("notifications/initialized", "notifications/cancelled"):
        return
    elif method == "ping":
        if not is_notification:
            _send_result(request_id, {})
    elif method == "tools/list":
        _send_result(request_id, {"tools": TOOLS})
    elif method == "tools/call":
        params = message.get("params") or {}
        try:
            payload = _call_tool(params.get("name"), params.get("arguments") or {})
            text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            _send_result(
                request_id,
                {"content": [{"type": "text", "text": text}], "isError": False},
            )
        except Exception as exc:  # Tool failures are reported to the model, not the transport.
            _send_result(
                request_id,
                {
                    "content": [{"type": "text", "text": f"{type(exc).__name__}: {exc}"}],
                    "isError": True,
                },
            )
    elif not is_notification:
        _send_error(request_id, -32601, f"Method not found: {method}")


def main() -> int:
    for raw_line in sys.stdin.buffer:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError as exc:
            _send_error(None, -32700, f"Parse error: {exc}")
            continue
        if isinstance(message, dict):
            _dispatch(message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
