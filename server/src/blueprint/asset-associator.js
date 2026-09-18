/**
 * asset-associator.js
 *
 * REFERENCE PAPER ASSETS — deterministic image/table extraction and
 * question/sub-question association from a Docling StructuredDocument.
 *
 * This module NEVER invents relationships. Every association carries the
 * deterministic evidence it was derived from (page, reading order, vertical
 * proximity, nearby question number/label text) plus a confidence level, and
 * anything ambiguous is surfaced as AMBIGUOUS_ASSET_ASSOCIATION instead of a
 * guessed answer.
 *
 * Spatial rules (PHASE 7):
 *   - Page-relative coordinates: vertical distances are normalized by the
 *     nearest page height the document actually exposes (page 1's fallback
 *     height when an asset's own page height is unknown), so thresholds are
 *     resolution- and page-size-independent.
 *   - An asset belongs to the question whose number appears in the text
 *     elements immediately above it on the same page (reading order), and is
 *     bounded by the NEXT question number on that page. When the nearest
 *     numbered element is too far above (normalized distance), or two
 *     different question numbers compete within the ambiguity window, the
 *     association is rejected as ambiguous rather than guessed.
 *   - Elements BELOW the asset on the same page (its sub-questions, e.g.
 *     "a) What do you observe? (2)") can refine the association down to a
 *     specific item when they sit within the same block and reference the
 *     asset ("picture", "diagram", "figure", "table", "image", "above").
 *
 * Deterministic and zero-LLM by design — same input document, same output.
 */

/** Text that plausibly introduces a visual asset. */
const ASSET_HINT_RE = /\b(picture|image|diagram|figure|fig\.|table|map|poster|observe|shown|above)\b/i;

/** "Q5", "5.", "Q.5)", "Question 5" → 5. Never years ("2026") or "2026-27". */
const QUESTION_NUMBER_RE = /^(?:q(?:uestion)?\s*\.?\s*)?(\d{1,2})(?!\d)\s*[.):\-]?\s*(.+)$/i;

/** How far (as a fraction of page height) an owning question may sit above an asset. */
const MAX_OWNER_DISTANCE = 0.55;
/** Two candidate owners within this normalized distance of each other → ambiguous. */
const AMBIGUITY_WINDOW = 0.12;

/**
 * Extract asset records from a StructuredDocument's elements.
 * @param {Object} doc - StructuredDocument (engine docling) or null
 * @returns {Array<Object>} assets: { id, type: 'image'|'table', pageNumber, bbox, order, text, meta }
 */
export function extractAssets(doc) {
  const elements = Array.isArray(doc?.elements) ? doc.elements : [];
  const assets = [];
  for (const el of elements) {
    if (el?.type !== 'picture' && el?.type !== 'table') continue;
    const tableRows = el?.meta?.rows ?? null;
    const tableCols = el?.meta?.cols ?? null;
    assets.push({
      id: String(el.id ?? `asset_${assets.length + 1}`),
      type: el.type === 'table' ? 'table' : 'image',
      pageNumber: el.pageNumber ?? null,
      bbox: Array.isArray(el.bbox) ? el.bbox : null, // [left, top, right, bottom]
      order: el.order ?? null,
      text: String(el.text ?? '').trim(),
      // Real pixel bytes for a picture element, when the ingestion engine
      // extracted them (Docling with generate_picture_images enabled). Never
      // fabricated — stays null when the engine supplied none.
      dataUri: el.type === 'picture' ? (el.meta?.dataUri ?? null) : null,
      mimeType: el.type === 'picture' ? (el.meta?.mimeType ?? null) : null,
      meta: {
        ...(el.type === 'table' && tableRows != null ? { rows: tableRows, cols: tableCols } : {}),
      },
    });
  }
  return assets;
}

/** Normalized (page-height-relative) vertical mid-Y of a bbox, or null. */
function midY(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  return (Number(bbox[1]) + Number(bbox[3])) / 2;
}

/** Nearest page height available in the document (page 1 first), or null. */
function referencePageHeight(doc) {
  const sizes = doc?.metadata?.pageSizes;
  if (Array.isArray(sizes) && sizes.length > 0 && Array.isArray(sizes[0]) && Number.isFinite(Number(sizes[0][1]))) {
    return Number(sizes[0][1]);
  }
  return null;
}

/**
 * Parse a leading question number out of a text element ("Q5. Study the
 * picture …" → 5). Returns null for non-questions (years, instructions).
 */
export function questionNumberOf(text) {
  const line = String(text ?? '').trim();
  const m = line.match(QUESTION_NUMBER_RE);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isInteger(num) || num <= 0 || num > 99) return null;
  // Reject years / long bare numbers ("2026 — answer all"). A question stem
  // always continues after the number; a year line is followed by a dash+year
  // shape or nothing meaningful.
  if (m[2] && /^(?:[-–—]\s*\d{2,4})?$/i.test(m[2].trim())) return null;
  return num;
}

/** First sub-question label ("a", "b", "i"…) in a text element, or null. */
export function subLabelOf(text) {
  const m = String(text ?? '').trim().match(/^\(?\s*([a-zA-Z]|[ivx]{1,4})\s*[).]/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Multi-signal decorative image check.
 * Identifies school logos, header graphics, footers, watermarks, or tiny decorative icons.
 */
export function isDecorativeImage(asset, doc = null) {
  if (!asset || asset.type !== 'image') return false;
  const pageHeight = referencePageHeight(doc);
  const bbox = asset.bbox;
  if (Array.isArray(bbox) && bbox.length >= 4) {
    const width = Math.abs(Number(bbox[2]) - Number(bbox[0]));
    const height = Math.abs(Number(bbox[3]) - Number(bbox[1]));
    // Tiny decorative icon or hairline separator
    if ((width > 0 && width < 25) || (height > 0 && height < 20)) return true;
    if (pageHeight && pageHeight > 0) {
      const topNorm = Number(bbox[1]) / pageHeight;
      const bottomNorm = Number(bbox[3]) / pageHeight;
      // Top header banner/logo band (top 8%) with very wide/small height
      if (topNorm < 0.08 && height < 60) return true;
      // Bottom footer band (bottom 6%)
      if (bottomNorm > 0.94) return true;
    }
  }
  return false;
}

/**
 * Compute reference-relative spatial layout metadata for an associated image asset.
 */
export function computeImageLayout(asset, _questionEls = [], doc = null) {
  const pageSizes = doc?.metadata?.pageSizes;
  const pageIdx = (asset.pageNumber || 1) - 1;
  const pageSize = Array.isArray(pageSizes) && pageSizes[pageIdx] ? pageSizes[pageIdx] : [600, 800];
  const pageWidth = Number(pageSize[0]) || 600;

  const bbox = Array.isArray(asset.bbox) && asset.bbox.length >= 4 ? asset.bbox : [50, 100, 350, 300];
  const width = Math.abs(Number(bbox[2]) - Number(bbox[0])) || 200;
  const height = Math.abs(Number(bbox[3]) - Number(bbox[1])) || 150;
  const midX = (Number(bbox[0]) + Number(bbox[2])) / 2;
  const widthRatio = Math.min(1.0, Math.max(0.1, Number((width / pageWidth).toFixed(2))));
  const aspectRatio = Number((width / height).toFixed(2));

  let alignment = 'center';
  const midXNorm = midX / pageWidth;
  if (midXNorm < 0.38) alignment = 'left';
  else if (midXNorm > 0.62) alignment = 'right';

  // Relative placement vs question text
  let placement = 'above';
  if (asset.associatedItem) {
    placement = 'inline';
  }

  return {
    placement,
    alignment,
    widthRatio,
    aspectRatio,
    width: Math.round(width),
    height: Math.round(height),
    gap: 12,
    order: asset.order ?? 0,
  };
}

/**
 * Associate extracted assets with questions/items from deterministic spatial
 * + reading-order evidence.
 *
 * @param {Object} args
 * @param {Object} args.doc - the StructuredDocument the assets came from
 * @param {Array<Object>} [args.assets] - extractAssets() output (recomputed when absent)
 * @param {Array<Object>} questions - analyzer questions: [{ number, label, items: [{ label }] }]
 * @returns {{ assets: Array<Object>, diagnostics: Array<Object> }}
 *   Each asset gains: { role, associatedQuestion, associatedItem,
 *   associationConfidence, associationEvidence, warnings: [] } — or
 *   association: null + AMBIGUOUS_ASSET_ASSOCIATION / UNASSOCIATED_* warning.
 */
export function associateAssets({ doc = null, assets = null, questions = [] } = {}) {
  const els = Array.isArray(doc?.elements) ? doc.elements : [];
  const pageHeight = referencePageHeight(doc);
  const knownNumbers = new Set(
    (Array.isArray(questions) ? questions : [])
      .map((q) => Number(q?.number))
      .filter((n) => Number.isInteger(n))
  );
  const itemsOf = (num) => {
    const q = (Array.isArray(questions) ? questions : []).find((x) => Number(x?.number) === num);
    return Array.isArray(q?.items) ? q.items : [];
  };

  const rawAssets = assets ?? extractAssets(doc);
  const outAssets = rawAssets.map((a) => ({ ...a, warnings: [] }));
  const diagnostics = [];

  for (const asset of outAssets) {
    asset.role = 'question-image';
    asset.associatedQuestion = null;
    asset.associatedItem = null;
    asset.association = null;
    asset.associationConfidence = 'NONE';
    asset.associationEvidence = {};

    // Decorative image filtering
    if (isDecorativeImage(asset, doc)) {
      asset.role = 'decorative';
      asset.warnings.push('DECORATIVE_IMAGE_IGNORED');
      continue;
    }

    const assetY = midY(asset.bbox);
    const candidates = []; // { number, distNorm, evidence }

    for (const el of els) {
      if (el?.type !== 'paragraph' && el?.type !== 'heading' && el?.type !== 'list_item') continue;
      if (el.pageNumber !== asset.pageNumber) continue;
      if (asset.order != null && el.order != null && el.order >= asset.order) continue; // above only (reading order)
      const num = questionNumberOf(el.text);
      if (num == null) continue;
      // Only a question the analyzer actually extracted can own an asset — a
      // stray numbered line that extraction did not classify as a question is
      // not a valid owner (the extracted question list is the source of truth).
      if (knownNumbers.size > 0 && !knownNumbers.has(num)) continue;
      const elY = midY(el.bbox);
      let distNorm = null;
      if (assetY != null && elY != null && pageHeight) {
        // Direction (above/below) comes from READING ORDER — coordinate-system
        // agnostic (real Docling bboxes are PDF bottom-up; rendered text layers
        // are top-down). The bbox contributes only the normalized DISTANCE so
        // far-away markers on the same page (or the previous page) cannot own
        // the asset.
        distNorm = Math.abs(assetY - elY) / pageHeight;
        if (distNorm > MAX_OWNER_DISTANCE) continue; // too far away to own it
      }
      candidates.push({
        number: num,
        distNorm,
        evidence: { elementId: el.id ?? null, order: el.order ?? null, textSnippet: String(el.text ?? '').slice(0, 80) },
      });
    }

    // Keep the closest candidate per question number; then require the
    // nearest two distinct numbers to be unambiguous.
    const byNumber = new Map();
    for (const c of candidates) {
      const prev = byNumber.get(c.number);
      if (!prev || (c.distNorm ?? Infinity) < (prev.distNorm ?? Infinity)) byNumber.set(c.number, c);
    }
    const ranked = [...byNumber.values()].sort((a, b) => (a.distNorm ?? Infinity) - (b.distNorm ?? Infinity));

    if (ranked.length === 0) {
      asset.role = asset.type === 'table' ? 'table' : 'image';
      asset.warnings.push(asset.type === 'table' ? 'UNASSOCIATED_TABLE' : 'UNASSOCIATED_IMAGE');
      diagnostics.push({
        scope: 'asset',
        field: 'assets',
        code: asset.type === 'table' ? 'UNASSOCIATED_TABLE' : 'UNASSOCIATED_IMAGE',
        severity: 'warn',
        message: `No question found above asset ${asset.id} on page ${asset.pageNumber ?? '?'} within the allowed distance — association left empty, never guessed.`,
        assetId: asset.id,
      });
      continue;
    }

    const best = ranked[0];
    const second = ranked[1];
    const ambiguous =
      second != null &&
      best.distNorm != null && second.distNorm != null &&
      Math.abs(best.distNorm - second.distNorm) < AMBIGUITY_WINDOW;

    if (ambiguous) {
      asset.warnings.push('AMBIGUOUS_ASSET_ASSOCIATION');
      asset.associationConfidence = 'LOW';
      asset.associationEvidence = { candidates: ranked.slice(0, 3).map((c) => ({ number: c.number, distNorm: c.distNorm })) };
      diagnostics.push({
        scope: 'asset',
        field: 'assets',
        code: 'AMBIGUOUS_ASSET_ASSOCIATION',
        severity: 'warn',
        message: `Asset ${asset.id} sits between question markers (${ranked.slice(0, 3).map((c) => `Q${c.number}`).join(', ')}) — association left empty.`,
        assetId: asset.id,
      });
      continue;
    }

    // ── Confident question association + best-effort item refinement ──
    asset.associatedQuestion = best.number;
    asset.associationConfidence = best.distNorm == null ? 'MEDIUM' : 'HIGH';
    asset.associationEvidence = { ownerElement: best.evidence, normalizedDistance: best.distNorm };

    // Item refinement: sub-question elements BELOW the asset on the same page,
    // within the same block, that reference the asset explicitly.
    let itemRef = null;
    for (const el of els) {
      if (el?.type !== 'paragraph' && el?.type !== 'list_item') continue;
      if (el.pageNumber !== asset.pageNumber) continue;
      if (asset.order != null && el.order != null && el.order <= asset.order) continue;
      const label = subLabelOf(el.text);
      if (!label) continue;
      if (!ASSET_HINT_RE.test(String(el.text ?? ''))) continue;
      const item = itemsOf(best.number).find((it) => String(it?.label ?? '').toLowerCase().startsWith(label));
      if (item) { itemRef = label; break; }
    }
    if (itemRef) {
      asset.associatedItem = itemRef;
      asset.associationEvidence.itemElement = itemRef;
    }
    asset.association = { question: asset.associatedQuestion, item: asset.associatedItem };
    asset.imageLayout = computeImageLayout(asset, els, doc);
  }

  return { assets: outAssets, diagnostics };
}

/**
 * Attach associated assets onto analyzer questions/items (additive — never
 * removes or overwrites existing fields).
 * @param {Array<Object>} questions - analyzer questions (mutated additively)
 * @param {Array<Object>} assets - associateAssets() output
 * @param {Object} [doc] - optional StructuredDocument
 */
export function attachAssetsToQuestions(questions, assets, doc = null) {
  const byNumber = new Map((Array.isArray(questions) ? questions : []).map((q) => [Number(q?.number), q]));
  for (const a of Array.isArray(assets) ? assets : []) {
    if (a.associatedQuestion == null || a.role === 'decorative') continue;
    const q = byNumber.get(Number(a.associatedQuestion));
    if (!q) continue;
    if (!Array.isArray(q.assets)) q.assets = [];
    if (!Array.isArray(q.imageAssets)) q.imageAssets = [];

    const assetRecord = {
      id: a.id,
      assetId: a.id,
      type: a.type,
      pageNumber: a.pageNumber,
      page: a.pageNumber,
      bbox: a.bbox,
      role: a.role,
      confidence: a.associationConfidence,
      warnings: a.warnings,
      url: a.url || a.dataUri || null,
      dataUri: a.dataUri || null,
      mimeType: a.mimeType || 'image/png',
      width: a.imageLayout?.width,
      height: a.imageLayout?.height,
      layout: a.imageLayout || computeImageLayout(a, [], doc),
    };

    q.assets.push(assetRecord);
    if (a.type === 'image') {
      q.imageAssets.push(assetRecord);
      q.type = 'IMAGE_BASED';
      q.isLocked = true;
      q.pattern = {
        ...(q.pattern || {}),
        instructionType: 'observe-image-answer',
        answerForm: 'image-based-response',
      };
      if (!q.imageLayout) {
        q.imageLayout = a.imageLayout || computeImageLayout(a, [], doc);
      }
    }

    if (a.associatedItem != null && Array.isArray(q.items)) {
      const item = q.items.find((it) => String(it?.label ?? '').toLowerCase().startsWith(String(a.associatedItem)));
      if (item) {
        if (!Array.isArray(item.assets)) item.assets = [];
        if (!Array.isArray(item.imageAssets)) item.imageAssets = [];
        item.assets.push({ id: a.id, type: a.type, pageNumber: a.pageNumber });
        if (a.type === 'image') item.imageAssets.push(assetRecord);
      }
    }
  }

  // Check multi-image arrangement
  for (const q of questions) {
    if (Array.isArray(q.imageAssets) && q.imageAssets.length > 1) {
      const yCoords = q.imageAssets.map((im) => midY(im.bbox)).filter((y) => y != null);
      const isRow = yCoords.length >= 2 && Math.abs(yCoords[0] - yCoords[1]) < 40;
      q.imageLayout = {
        ...(q.imageLayout || {}),
        arrangement: isRow ? 'row' : 'column',
      };
    }
  }
}

/**
 * Deterministic structural checks over the asset set (PHASE 9 items 12–13):
 * page consistency (assets reference pages the document actually has) and
 * reading-order consistency (element orders are unique so 'above/below'
 * reasoning is sound). Existing warning codes from association are untouched.
 * @param {Object} doc - the StructuredDocument
 * @param {Array<Object>} assets - associateAssets() output
 * @returns {Array<Object>} additional diagnostics
 */
export function validateAssetStructure(doc, assets) {
  const diagnostics = [];
  const pageCount = Number(doc?.pageCount ?? 0);
  for (const a of Array.isArray(assets) ? assets : []) {
    if (a.pageNumber != null && pageCount > 0 && (a.pageNumber < 1 || a.pageNumber > pageCount)) {
      a.warnings.push('ASSET_PAGE_OUT_OF_RANGE');
      diagnostics.push({
        scope: 'asset',
        field: 'assets',
        code: 'ASSET_PAGE_OUT_OF_RANGE',
        severity: 'warn',
        message: `Asset ${a.id} references page ${a.pageNumber} but the document has ${pageCount} page(s).`,
        assetId: a.id,
        pageNumber: a.pageNumber,
        pageCount,
      });
    }
  }
  const orders = (Array.isArray(doc?.elements) ? doc.elements : [])
    .map((e) => e?.order)
    .filter((o) => o != null)
    .map(Number);
  const unique = new Set(orders);
  if (orders.length > 1 && unique.size !== orders.length) {
    diagnostics.push({
      scope: 'paper',
      field: 'readingOrder',
      code: 'READING_ORDER_CONFLICT',
      severity: 'warn',
      message: `Document element orders are not unique (${orders.length} elements, ${unique.size} distinct orders) — spatial above/below reasoning is degraded for this document.`,
    });
  }
  return diagnostics;
}

export default { extractAssets, associateAssets, attachAssetsToQuestions, validateAssetStructure, questionNumberOf, subLabelOf };
