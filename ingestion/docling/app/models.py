"""Structured document model for the Docling ingestion worker.

Defines the JSON shape the worker returns for every converted document. The
Node.js side (server/src/ingestion) consumes this — the two sides must agree
on these field names.
"""

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional

# Element types we normalize Docling items into. Generic on purpose — no
# document type or subject is special-cased anywhere in this worker.
ELEMENT_TYPES = {
    "heading",
    "paragraph",
    "list_item",
    "table",
    "picture",
    "caption",
    "text",  # fallback for typed items we don't map more specifically
}


@dataclass
class Element:
    id: str
    pageNumber: Optional[int]
    type: str
    text: str
    order: int
    parentId: Optional[str] = None
    headingLevel: Optional[int] = None
    bbox: Optional[List[float]] = None
    headingPath: List[str] = field(default_factory=list)
    meta: Dict[str, Any] = field(default_factory=dict)  # e.g. table row/col counts

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class StructuredDocument:
    documentId: str
    engine: str
    doclingVersion: str
    pageCount: int
    elements: List[Element] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "documentId": self.documentId,
            "engine": self.engine,
            "doclingVersion": self.doclingVersion,
            "pageCount": self.pageCount,
            "metadata": self.metadata,
            "elements": [e.to_dict() for e in self.elements],
            # convenience projections (plain text lists, derived from elements)
            "headings": [e.to_dict() for e in self.elements if e.type == "heading"],
            "paragraphs": [e.to_dict() for e in self.elements if e.type == "paragraph"],
            "lists": [e.to_dict() for e in self.elements if e.type == "list_item"],
            "tables": [e.to_dict() for e in self.elements if e.type == "table"],
            "pictures": [e.to_dict() for e in self.elements if e.type == "picture"],
        }
