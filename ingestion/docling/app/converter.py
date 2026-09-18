"""Docling converter: PDF/image → StructuredDocument.

Uses the official Docling API. Written defensively against minor version
differences: item iteration, label mapping and provenance access all fall back
gracefully, and OCR stays at the Docling default (enabled for PDFs).
"""

from __future__ import annotations

import hashlib
import threading
import time
from typing import Any, Dict, List, Optional

from .models import Element, StructuredDocument

# Docling model init is expensive — one converter per process, guarded by a lock.
_converter = None
_lock = threading.Lock()


def _get_converter():
    global _converter
    if _converter is None:
        with _lock:
            if _converter is None:
                from docling.document_converter import DocumentConverter, PdfFormatOption
                from docling.datamodel.base_models import InputFormat
                from docling.datamodel.pipeline_options import PdfPipelineOptions

                # Default pipeline: PDF with OCR where needed, reading order and
                # layout model enabled — EXCEPT generate_picture_images, which
                # must be on so each picture element carries its own cropped
                # bitmap (item.get_image()). Without it Docling only reports a
                # picture's position/caption, never its pixels, and the image
                # can never reach a vision model or a renderer.
                pdf_opts = PdfPipelineOptions()
                pdf_opts.generate_picture_images = True
                pdf_opts.images_scale = 2.0
                _converter = DocumentConverter(
                    format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_opts)}
                )
    return _converter


def _picture_data_uri(item: Any, document: Any) -> Optional[Dict[str, str]]:
    """Best-effort PNG data URI for a picture item's cropped image.

    Returns None (never fabricates) when the pipeline did not attach an image
    — e.g. a Docling version/build without generate_picture_images support.
    """
    try:
        import base64
        import io

        get_image = getattr(item, "get_image", None)
        if not callable(get_image):
            return None
        pil_image = get_image(document)
        if pil_image is None:
            return None
        buf = io.BytesIO()
        pil_image.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return {"dataUri": f"data:image/png;base64,{b64}", "mimeType": "image/png"}
    except Exception:
        return None


# Map Docling DocItemLabel → our normalized element types.
_LABEL_MAP = {
    "title": "heading",
    "section_header": "heading",
    "subtitle": "heading",
    "heading": "heading",
    "paragraph": "paragraph",
    "text": "paragraph",
    "list_item": "list_item",
    "caption": "caption",
    "picture": "picture",
    "table": "table",
    "code": "paragraph",
    "formula": "text",
    "page_header": "text",
    "page_footer": "text",
}


def _norm_type(label: Any) -> str:
    s = str(getattr(label, "value", label) or "").strip().lower()
    return _LABEL_MAP.get(s, "text")


def _heading_level(label: Any) -> Optional[int]:
    """Best-effort heading depth from a label like 'section_header_level_2'."""
    s = str(getattr(label, "value", label) or "")
    for i in range(1, 7):
        if f"level_{i}" in s or f"_h{i}" in s.lower():
            return i
    return 1 if _norm_type(label) == "heading" else None


def _prov(prov_list: Any) -> tuple:
    """Extract (page_number, bbox) from a Docling provenance list."""
    if not prov_list:
        return None, None
    try:
        p0 = prov_list[0]
        page_no = getattr(p0, "page_no", None)
        bbox = getattr(p0, "bbox", None)
        if bbox is not None:
            bbox = [round(float(bbox.l), 2), round(float(bbox.t), 2),
                    round(float(bbox.r), 2), round(float(bbox.b), 2)]
        return (int(page_no) if page_no is not None else None), bbox
    except Exception:
        return None, None


def _as_text(value: Any) -> str:
    """Coerce a Docling item attribute to clean text.

    Docling 2.x exposes some attributes as METHODS on certain item types
    (e.g. PictureItem.caption_text is callable, not a str property) — calling
    `.strip()` on those raised AttributeError and failed whole conversions of
    scanned papers. Calling callables and stringifying anything else keeps the
    conversion alive.
    """
    try:
        if callable(value):
            value = value()
    except Exception:
        return ""
    return str(value or "").strip()


def _read_version() -> str:
    try:
        from importlib.metadata import version
        return version("docling")
    except Exception:
        return "unknown"


def docling_version() -> str:
    try:
        import docling
        return str(getattr(docling, "__version__", None) or _read_version())
    except Exception:
        return "unavailable"


def convert_file(file_path: str, document_id: Optional[str] = None) -> StructuredDocument:
    """Convert a file on disk into a StructuredDocument (blocking)."""
    t0 = time.time()
    converter = _get_converter()
    result = converter.convert(file_path)
    document = result.document

    doc_id = document_id or ("doc_" + hashlib.sha256(str(file_path).encode()).hexdigest()[:16])

    # ── Page count ────────────────────────────────────────────────────────────
    try:
        page_count = len(document.pages)
    except Exception:
        page_count = 0

    # ── Page sizes (per page, in reading order) ─────────────────────────────
    # Exposed so consumers can normalize spatial distances (bbox coordinates
    # are in page units, which differ per document/resolution).
    page_sizes: List[List[float]] = []
    try:
        pages = getattr(document, "pages", {})
        if isinstance(pages, dict):
            page_iter = [pages[k] for k in sorted(pages.keys())]
        else:
            page_iter = list(pages)
        for page in page_iter:
            size = getattr(page, "size", None)
            w = float(getattr(size, "width", 0) or 0)
            h = float(getattr(size, "height", 0) or 0)
            page_sizes.append([round(w, 2), round(h, 2)])
    except Exception:
        page_sizes = []

    # ── Iterate items in READING ORDER with hierarchy level ──────────────────
    try:
        iterator = list(document.iterate_items())
    except Exception:
        iterator = []

    # Fallback when iterate_items is unavailable: use the text/tables lists.
    if not iterator:
        for item in list(getattr(document, "texts", []) or []):
            iterator.append((item, 0))

    elements: List[Element] = []
    order = 0
    heading_stack: List[str] = []  # current heading path

    for item, level in iterator:
        label = getattr(item, "label", None)
        etype = _norm_type(label)
        page_no, bbox = _prov(getattr(item, "prov", None))
        text = ""

        picture_meta: Dict[str, Any] = {}
        if etype == "table":
            # TableItem: flatten to readable CSV rows — shape kept in meta.
            tbl: Dict[str, Any] = {}
            try:
                df = item.export_to_dataframe()
                text = df.to_csv(index=False, header=True)
                tbl = {"rows": int(df.shape[0]), "cols": int(df.shape[1])}
            except Exception:
                text = _as_text(getattr(item, "text", ""))
        elif etype == "picture":
            text = _as_text(getattr(item, "caption_text", ""))
            picture_meta = _picture_data_uri(item, document) or {}
        else:
            text = _as_text(getattr(item, "text", ""))

        if not text and etype != "picture":
            continue
        if etype in ("page_header", "page_footer"):
            continue  # boilerplate — keep it out of the content stream

        # Maintain the heading path: headings update it; everything else inherits.
        hlevel = _heading_level(label) if etype == "heading" else None
        if etype == "heading" and hlevel is not None:
            heading_stack = heading_stack[: hlevel - 1]
            heading_stack.append(text[:120])

        item_id = str(getattr(item, "self_ref", None) or f"e{order}")
        elements.append(Element(
            id=item_id,
            pageNumber=page_no,
            type=etype,
            text=text,
            order=order,
            headingLevel=hlevel,
            bbox=bbox,
            # A heading itself sits under its PARENT heading path.
            headingPath=list(heading_stack[:-1]) if etype == "heading" else list(heading_stack),
            meta=picture_meta,
        ))
        order += 1

    meta = {
        "sourcePath": str(file_path),
        "convertStatus": str(getattr(result, "status", "")),
        "elapsedMs": int((time.time() - t0) * 1000),
        # Per-page [width, height] in page units — consumers normalize spatial
        # reasoning with these; empty when the Docling version hides sizes.
        "pageSizes": page_sizes,
    }
    return StructuredDocument(
        documentId=doc_id,
        engine="docling",
        doclingVersion=str(doc_version := docling_version()),
        pageCount=page_count,
        elements=elements,
        metadata=meta,
    )
