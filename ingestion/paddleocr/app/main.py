"""PaddleOCR worker — stdlib HTTP entrypoint (mirrors ingestion/docling/app/main.py).

Endpoints:
  GET  /health  → { ok, service, engine, paddleVersion, paddleOcrVersion }
  POST /ocr     → body: { imageBase64, filename? }
                  → { ok, text, blocks[], width, height, processingTimeMs }

No web framework — http.server keeps the dependency surface at
paddlepaddle + paddleocr + pillow. Images arrive base64-in-JSON so Node can
reuse the exact same call shape as the Docling worker (fileBase64).

Run:
  cd ingestion/paddleocr
  .venv/Scripts/python.exe -m app.main        (port via PADDLEOCR_PORT, default 8102)

Security: body size capped, image type/size validated, engine errors returned
as safe strings, document content never logged, temp files never created.
"""

from __future__ import annotations

import base64
import json
import os
import time
# Single-threaded ON PURPOSE: the Paddle predictor is not thread-safe across
# threads (alternating requests from ThreadingHTTPServer threads fail with
# RuntimeError), and CPU inference is serialized in practice anyway. One
# request is processed at a time; concurrent clients wait on the socket.
from http.server import BaseHTTPRequestHandler, HTTPServer

from .ocr_service import engine_status, ocr_image_bytes

MAX_BODY_BYTES = 32 * 1024 * 1024  # 32 MiB (matches the image cap)
ALLOWED_PREFIXES = (
    b"data:image/png;base64,",
    b"data:image/jpeg;base64,",
    b"data:image/jpg;base64,",
    b"data:image/webp;base64,",
)
ALLOWED_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")

MAX_CONCURRENCY = 1  # serialized server (see import note above)


class Handler(BaseHTTPRequestHandler):
    server_version = "PaddleOcrWorker/1.0"

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # quieter; never log content
        if "/health" not in (args[0] if args else ""):
            print("[paddleocr-worker]", fmt % args, flush=True)

    # -- routes --------------------------------------------------------------
    def do_GET(self):
        if self.path.rstrip("/") in ("", "/health"):
            status = engine_status()
            self._send_json(
                200,
                {
                    "ok": status.get("engine") != "error",
                    "service": "paddleocr",
                    "engine": status,
                    "paddleVersion": _pkg_version("paddlepaddle"),
                    "paddleOcrVersion": _pkg_version("paddleocr"),
                },
            )
            return
        self._send_json(404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "not found"}})

    def do_POST(self):
        if self.path.rstrip("/") != "/ocr":
            self._send_json(404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "not found"}})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY_BYTES:
                self._send_json(413, {"ok": False, "error": {"code": "BAD_BODY", "message": f"bad body size {length}"}})
                return
            req = json.loads(self.rfile.read(length).decode("utf-8"))

            b64 = req.get("imageBase64") or ""
            if not b64:
                self._send_json(400, {"ok": False, "error": {"code": "NO_IMAGE", "message": "imageBase64 required"}})
                return
            # Strip an optional data-URI prefix, validating the media type.
            if b64[:22].startswith("data:"):
                matched = next((p for p in ALLOWED_PREFIXES if b64.lower().startswith(p.decode())), None)
                if not matched:
                    self._send_json(415, {"ok": False, "error": {"code": "UNSUPPORTED_MEDIA", "message": "only png/jpeg/webp images accepted"}})
                    return
                b64 = b64.split(",", 1)[1]

            filename = str(req.get("filename") or "")
            if filename and not filename.lower().endswith(ALLOWED_EXTS):
                self._send_json(415, {"ok": False, "error": {"code": "UNSUPPORTED_MEDIA", "message": "unsupported filename extension"}})
                return

            try:
                data = base64.b64decode(b64, validate=False)
            except Exception:  # noqa: BLE001
                self._send_json(400, {"ok": False, "error": {"code": "BAD_BASE64", "message": "imageBase64 is not valid base64"}})
                return

            result = ocr_image_bytes(data)
            status = 200 if result.get("ok") else 422
            self._send_json(status, result)
        except Exception as exc:  # noqa: BLE001 — final safety net
            self._send_json(500, {"ok": False, "error": {"code": "INTERNAL", "message": type(exc).__name__}})


def _pkg_version(name: str):
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:  # noqa: BLE001
        return None


def main():
    port = int(os.environ.get("PADDLEOCR_PORT", "8102"))
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"[paddleocr-worker] listening on http://127.0.0.1:{port} (POST /ocr, GET /health)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[paddleocr-worker] shutting down", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
