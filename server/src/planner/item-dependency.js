/**
 * item-dependency.js — PURE item-level image-dependency classification.
 *
 * Zero imports, zero LLM, zero I/O: safe for the planner (whose N3 contract
 * forbids retrieval/LLM seams) and for the validator. The semantic image
 * grounding service re-exports these for backward compatibility.
 *
 * The spec correction: image dependency is decided PER REFERENCE ITEM (the
 * reference's own relationship with the image), not blanket across an
 * IMAGE_BASED question:
 *   - IMAGE_DEPENDENT  — the item explicitly asks about something SHOWN in
 *                        the image ("shown in the diagram") ⇒ the generated
 *                        part MUST require the image.
 *   - IMAGE_CONTEXTUAL — the item shares the image's topic but its answer is
 *                        topic knowledge ⇒ the generated part stays on topic
 *                        and must NOT be rejected merely because it can be
 *                        answered without the image.
 */

/** Visual-cue words that mark an item as demanding image inspection. */
export const VISUAL_CUE_RE = /\b(shown|depicted|picture|diagram|figure|image|illustration|illustrated|labelled|labeled|flow\s?chart|chart|graph|map|photograph|above)\b/i;

/**
 * Strip non-academic noise from reference text BEFORE it is used as a topic
 * anchor, a classification input, or a regeneration KEEP instruction:
 *   - marks expressions: [02], [ 5 ], trailing (2)/(iv) style
 *   - course-outcome / Bloom / mapping codes: CO1, COl (OCR'd CO1), BL3,
 *     PO3, PS2, BT4, K2
 *   - dotted section codes: 1.2.3
 * Academic words are never touched — generic shapes only, no subject terms.
 */
export function cleanAcademicText(text) {
  return String(text || '')
    .replace(/\[\s*\d{1,2}\s*\]/g, ' ')
    .replace(/\((?:\d{1,2}|[ivx]{1,4})\)/gi, ' ')
    // "COl" is the OCR of CO1 (digit read as letter l); the negative lookahead
    // keeps real words ("cold", "collection") intact.
    .replace(/\b(?:co\s*l?\s*\d+|co\s*l(?![a-z])|bl\s*\d+|po\s*\d+|ps\s*\d+|bt\s*\d+|k\s*\d+)\b/gi, ' ')
    .replace(/\b\d+(?:\.\d+)+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classify ONE reference item's image dependency. UNKNOWN only when the item
 * carries no usable text (the caller decides the safe fallback).
 */
export function classifyItemDependency(item) {
  const raw = String(item?.text ?? item?.referenceText ?? '').trim();
  const cleaned = cleanAcademicText(raw);
  if (!cleaned) return 'UNKNOWN';
  return VISUAL_CUE_RE.test(cleaned) ? 'IMAGE_DEPENDENT' : 'IMAGE_CONTEXTUAL';
}

/**
 * Per-item dependency labels for a whole slot, positionally aligned with
 * slot.items (sub-part i ↔ item i — the same mapping
 * checkPerItemTopicFidelity uses). Fail-safe: a reference image question
 * where NO item shows an explicit visual cue falls back to the legacy
 * slot-level model (every part held to visual dependency) — the conservative
 * contract protects genuine image dependency when the reference's own
 * wording gives no signal.
 */
export function labelSlotItemDependencies(slot) {
  const items = Array.isArray(slot?.items) ? slot.items : [];
  const labeled = items.map((it) => classifyItemDependency(it));
  if (labeled.length > 0 && labeled.every((d) => d !== 'IMAGE_DEPENDENT')) {
    return labeled.map(() => 'IMAGE_DEPENDENT');
  }
  return labeled;
}
