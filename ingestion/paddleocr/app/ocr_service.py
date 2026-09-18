"""PaddleOCR engine wrapper — lazy singleton, CPU-only, thread-safe.

Mirrors the isolation pattern of the Docling worker (`ingestion/docling/app/`):
the heavy engine is loaded on first use, errors are converted to safe strings,
and no document content is ever logged.

Supports PaddleOCR 3.x (`PaddleOCR.predict`) and 2.x (`ocr.ocr`) output shapes
so the venv can pin either version without code changes here.
"""

from __future__ import annotations

import io
import os
import threading
import time

from PIL import Image

_MAX_PIXELS = 40_000_000  # ~2480x3508 A4 @300dpi is 8.7MP — 40MP is a safety ceiling

_engine = None
_engine_lock = threading.Lock()
_engine_error: str | None = None

# First-use model downloads can take minutes on slow links.
LOAD_TIMEOUT_S = int(os.environ.get("PADDLE_LOAD_TIMEOUT_S", "600"))


class OcrInputError(Exception):
    """Raised when the uploaded image cannot be used (bad type/size/content)."""


class OcrEngineError(Exception):
    """Raised when the engine itself fails (missing lib, inference error)."""


def _load_engine():
    """Create the PaddleOCR engine once (CPU-only, English, angle cls on)."""
    global _engine, _engine_error
    if _engine is not None:
        return _engine
    with _engine_lock:
        if _engine is not None:
            return _engine
        try:
            # Imported here so /health reports "engine: unloaded" instead of
            # crashing when paddleocr is not installed.
            from paddleocr import PaddleOCR  # noqa: deferred import

            kwargs = {
                "use_textline_orientation": True,  # 3.x flag (angle classifier)
                "lang": os.environ.get("PADDLE_OCR_LANG", "en"),
            }
            try:
                # PaddleOCR 3.x: device selection is explicit.
                engine = PaddleOCR(device="cpu", **kwargs)
            except (TypeError, ValueError):
                # PaddleOCR 2.x: different constructor kwargs.
                engine = PaddleOCR(
                    use_angle_cls=True,
                    lang=os.environ.get("PADDLE_OCR_LANG", "en"),
                    show_log=False,
                )
            _engine = engine
        except Exception as exc:  # noqa: BLE001 — report as safe string
            _engine_error = f"{type(exc).__name__}: {exc}"
            raise OcrEngineError(_engine_error) from exc
    return _engine


def engine_status() -> dict:
    """Health payload — never raises."""
    if _engine is not None:
        return {"engine": "loaded", "device": "cpu"}
    if _engine_error:
        return {"engine": "error", "error": _engine_error}
    return {"engine": "unloaded"}


def _decode_image(data: bytes) -> Image.Image:
    """Decode + validate the uploaded image bytes. Raises OcrInputError."""
    if not data:
        raise OcrInputError("empty image payload")
    if len(data) > 32 * 1024 * 1024:
        raise OcrInputError("image too large (max 32 MiB)")
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:  # noqa: BLE001
        raise OcrInputError(f"invalid image: {type(exc).__name__}") from exc
    if img.width <= 0 or img.height <= 0:
        raise OcrInputError("invalid image dimensions")
    if img.width * img.height > _MAX_PIXELS:
        raise OcrInputError("image resolution too high")
    return img


def _pil_to_numpy(img: Image.Image):
    """RGB uint8 HWC numpy array (paddleocr accepts ndarray input)."""
    import numpy as np  # deferred — ships with paddle

    if img.mode != "RGB":
        img = img.convert("RGB")
    return np.asarray(img, dtype=np.uint8)


# ── Result normalization ────────────────────────────────────────────────────


def _norm_conf(value) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    # Some versions return 0..100.
    return v / 100.0 if v > 1.5 else v


def _blocks_from_pairs(pairs) -> list[dict]:
    """2.x shape: list of [box(4 points), (text, conf)]."""
    blocks = []
    for item in pairs or []:
        try:
            box, (text, conf) = item[0], item[1]
        except (TypeError, ValueError, IndexError):
            continue
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        blocks.append(
            {
                "text": str(text),
                "bbox": [min(xs), min(ys), max(xs), max(ys)],
                "confidence": _norm_conf(conf),
            }
        )
    return blocks


def _blocks_from_3x(result_obj) -> list[dict]:
    """3.x `predict` shape: dicts with rec_texts / rec_scores / rec_polys."""
    texts = result_obj.get("rec_texts") or []
    scores = result_obj.get("rec_scores") or []
    polys = result_obj.get("rec_polys") or result_obj.get("rec_boxes") or []
    blocks = []
    for i, text in enumerate(texts):
        conf = _norm_conf(scores[i]) if i < len(scores) else None
        bbox = None
        if i < len(polys):
            poly = polys[i]
            try:
                if hasattr(poly, "tolist"):
                    poly = poly.tolist()
                if isinstance(poly[0], (list, tuple)):
                    # N points [[x,y], [x,y], ...] → flatten to [x0,y0,x1,y1,…]
                    flat = [float(v) for pt in poly for v in pt]
                else:
                    flat = [float(v) for v in poly]
                if len(flat) >= 8:  # 4 points (polygon)
                    xs, ys = flat[0::2], flat[1::2]
                    bbox = [min(xs), min(ys), max(xs), max(ys)]
                elif len(flat) == 4:  # already x1,y1,x2,y2
                    bbox = flat
            except (TypeError, ValueError, IndexError):
                bbox = None
        blocks.append({"text": str(text), "bbox": bbox, "confidence": conf})
    return blocks


# ── Public API ──────────────────────────────────────────────────────────────


def ocr_image_bytes(data: bytes) -> dict:
    """Run PaddleOCR over an image. Returns the page schema (never raises)."""
    t0 = time.time()
    try:
        img = _decode_image(data)
        width, height = img.size
        arr = _pil_to_numpy(img)

        engine = _load_engine()
        raw = engine.predict(arr) if hasattr(engine, "predict") else engine.ocr(arr, cls=True)

        blocks: list[dict] = []
        if isinstance(raw, list) and raw:
            first = raw[0]
            if isinstance(first, dict):
                blocks = _blocks_from_3x(first)
            elif isinstance(first, (list, tuple)):
                blocks = _blocks_from_pairs(first)
        blocks = [b for b in blocks if b.get("text")]

        # Reading order: top-to-bottom, then left-to-right (Paddle gives
        # detection order, which is not guaranteed to be reading order).
        blocks.sort(key=lambda b: ((b["bbox"][1] if b.get("bbox") else 0), (b["bbox"][0] if b.get("bbox") else 0)))
        text = "\n".join(b["text"] for b in blocks)
        confs = [b["confidence"] for b in blocks if b.get("confidence") is not None]
        avg_conf = round(sum(confs) / len(confs), 4) if confs else None

        return {
            "ok": True,
            "text": text,
            "blocks": blocks,
            "width": width,
            "height": height,
            "avgConfidence": avg_conf,
            "blockCount": len(blocks),
            "processingTimeMs": int((time.time() - t0) * 1000),
        }
    except OcrInputError as exc:
        return {"ok": False, "error": {"code": "INVALID_IMAGE", "message": str(exc)},
                "processingTimeMs": int((time.time() - t0) * 1000)}
    except OcrEngineError as exc:
        return {"ok": False, "error": {"code": "ENGINE_ERROR", "message": str(exc)},
                "processingTimeMs": int((time.time() - t0) * 1000)}
    except Exception as exc:  # noqa: BLE001 — final safety net
        return {"ok": False, "error": {"code": "OCR_FAILED", "message": f"{type(exc).__name__}"},
                "processingTimeMs": int((time.time() - t0) * 1000)}
