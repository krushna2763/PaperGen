"""Health check for the Docling worker (import sanity + version probe)."""


def health() -> dict:
    out = {"ok": False, "engine": "docling", "doclingVersion": None}
    try:
        from .converter import docling_version
        v = docling_version()
        out["doclingVersion"] = v
        out["ok"] = v not in (None, "unknown", "unavailable")
    except Exception as e:  # pragma: no cover
        out["error"] = str(e)
    return out
