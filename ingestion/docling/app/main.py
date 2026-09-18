"""Docling ingestion worker — stdlib HTTP entrypoint.

Endpoints:
  GET  /health   → { ok, engine, doclingVersion }
  POST /convert  → body: { fileBase64, filename, documentId? }
                   → { success, document, meta }

No web framework — http.server keeps the dependency surface at `docling` only.
Run:  .venv/Scripts/python.exe -m app.main   (port via DOCLING_PORT, default 8100)
"""

from __future__ import annotations

import base64
import json
import os
import tempfile
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .converter import convert_file
from .health import health

MAX_BODY_BYTES = 64 * 1024 * 1024  # 64 MiB


class Handler(BaseHTTPRequestHandler):
    server_version = "DoclingIngestionWorker/1.0"

    # -- plumbing ------------------------------------------------------------
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # quieter logs
        if "/health" not in (args[0] if args else ""):
            print("[docling-worker]", fmt % args, flush=True)

    # -- routes --------------------------------------------------------------
    def do_GET(self):
        if self.path.rstrip("/") in ("", "/health"):
            h = health()
            self._send_json(200, h)
            return
        self._send_json(404, {"success": False, "error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/convert":
            self._send_json(404, {"success": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY_BYTES:
                self._send_json(413, {"success": False, "error": f"bad body size {length}"})
                return
            req = json.loads(self.rfile.read(length).decode("utf-8"))

            b64 = req.get("fileBase64")
            filename = req.get("filename") or "upload.pdf"
            if not b64:
                # Alternative: server-local path (same machine).
                path = req.get("filePath")
                if not path or not os.path.isfile(path):
                    self._send_json(400, {"success": False, "error": "fileBase64 or filePath required"})
                    return
            else:
                data = base64.b64decode(b64)
                suffix = os.path.splitext(filename)[1] or ".pdf"
                fd, path = tempfile.mkstemp(suffix=suffix)
                with os.fdopen(fd, "wb") as f:
                    f.write(data)

            t0 = time.time()
            doc = convert_file(path, document_id=req.get("documentId"))
            payload = {
                "success": True,
                "document": doc.to_dict(),
                "meta": {
                    "engine": "docling",
                    "doclingVersion": doc.doclingVersion,
                    "elapsedMs": int((time.time() - t0) * 1000),
                    "filename": filename,
                },
            }
            self._send_json(200, payload)
        except Exception as e:  # noqa: BLE001 — worker must always answer JSON
            self._send_json(500, {"success": False, "error": f"{type(e).__name__}: {e}"})


def main() -> None:
    port = int(os.environ.get("DOCLING_PORT", "8100"))
    # Avoid torch/OpenMP CPU oversubscription inside the worker.
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    h = health()
    print(f"[docling-worker] listening on 127.0.0.1:{port} | docling={h.get('doclingVersion')} ok={h.get('ok')}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
