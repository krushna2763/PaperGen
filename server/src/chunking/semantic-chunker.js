/**
 * semantic-chunker.js — STRUCTURE-AWARE SEMANTIC CHUNKING (PARTS 4–7).
 *
 * Turns a structured document (Docling elements, or pseudo-elements derived
 * from legacy plain text) into PARENT/CHILD chunks:
 *
 *   section (heading path)  →  PARENT chunk(s)   = coherent topic units
 *                              └── CHILD chunks  = retrieval units
 *
 * Rules (PART 6):
 *   - Structure boundaries ALWAYS win over size limits.
 *   - A paragraph/section that is already coherent is never split.
 *   - Oversized parents/children split at PARAGRAPH then SENTENCE boundaries —
 *     never mid-sentence, mid-question, mid-list-item or mid-table-row.
 *   - Overlap is applied at the last whole sentence, never inside one.
 *
 * Fully generic: no class/subject/unit/question-number special cases (PART 37).
 */

import { createHash } from 'crypto';
import { env } from '../config/env.js';
import { detectChunkHeading } from '../document/notes-chunker.js';

// ─── Token helpers (deterministic whitespace tokens; documented approximation) ─
export function countTokens(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/** Split into sentences, keeping terminal punctuation attached. */
export function splitSentences(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts = clean.match(/[^.!?]+[.!?]+(?:["')\]]+)?(?:\s|$)|[^.!?]+$/g) || [clean];
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Split a long text at sentence boundaries into ≤maxToken runs (with optional overlap). */
function splitBySentences(text, maxTokens, overlapTokens) {
  const sentences = splitSentences(text);
  const runs = [];
  let cur = [];
  let curTok = 0;
  for (const s of sentences) {
    const st = countTokens(s);
    if (cur.length > 0 && curTok + st > maxTokens) {
      runs.push(cur.join(' '));
      // Overlap: repeat trailing whole sentences (never a partial one).
      if (overlapTokens > 0) {
        let back = [];
        let backTok = 0;
        for (let i = cur.length - 1; i >= 0; i--) {
          const t = countTokens(cur[i]);
          if (backTok + t > overlapTokens) break;
          back.unshift(cur[i]);
          backTok += t;
        }
        cur = back;
        curTok = backTok;
      } else {
        cur = [];
        curTok = 0;
      }
    }
    // A single sentence longer than max still becomes its own run (no mid-sentence cut).
    cur.push(s);
    curTok += st;
  }
  if (cur.length > 0) runs.push(cur.join(' '));
  return runs;
}

const hashText = (text) => createHash('sha256').update(String(text)).digest('hex');

/**
 * Group flat elements into SECTIONS by heading path.
 * @param {Array<{id?,type,text,pageNumber?,headingPath?}>} elements
 */
function buildSections(elements) {
  const sections = [];
  let current = { headingPath: [], elements: [] };
  for (const el of elements) {
    const type = String(el.type || 'text');
    if (type === 'heading') {
      // A heading opens a NEW section (its own text is the section title).
      if (current.elements.length > 0) sections.push(current);
      current = {
        headingPath: [...(el.headingPath || []), String(el.text || '').trim()].filter(Boolean),
        elements: [],
      };
      continue;
    }
    current.elements.push(el);
  }
  if (current.elements.length > 0 || sections.length === 0) sections.push(current);
  return sections;
}

/** Flatten a section's elements into typed blocks (paragraph / list / table). */
function elementBlocks(section) {
  const blocks = [];
  let listBuf = [];
  const flushList = () => {
    if (listBuf.length > 0) {
      blocks.push({ kind: 'list', text: listBuf.join('\n') });
      listBuf = [];
    }
  };
  for (const el of section.elements) {
    const t = String(el.text || '').trim();
    if (!t) continue;
    if (String(el.type) === 'list_item') {
      listBuf.push(`- ${t}`);
      continue;
    }
    flushList();
    blocks.push({ kind: String(el.type) === 'table' ? 'table' : 'para', text: t, pageNumber: el.pageNumber ?? null });
  }
  flushList();
  return blocks;
}

/**
 * Chunk one section into parent(s) → children.
 * Returns { parents: [], children: [] } with full metadata (PART 7).
 */
function chunkSection(section, ctx, opts) {
  const { minTokens, maxTokens, overlapTokens } = opts;
  const { documentId, cls, subject, unit, sourceType } = ctx;
  const parents = [];
  const children = [];

  const headingText = section.headingPath.join(' — ');
  const blocks = elementBlocks(section);
  if (blocks.length === 0) return { parents, children };

  // ── 1) PARAGRAPH-GROUPED PARENT RUNS (never split a coherent para) ───────
  const parentRuns = [];
  let run = [];
  let runTok = 0;
  for (const b of blocks) {
    const bt = countTokens(b.text);
    // A single block larger than max becomes its own oversized run — it is
    // coherent and gets split only at the CHILD level, never mid-block here.
    if (runTok + bt > maxTokens && run.length > 0) {
      parentRuns.push(run);
      run = [];
      runTok = 0;
    }
    run.push(b);
    runTok += bt;
  }
  if (run.length > 0) parentRuns.push(run);

  // ── 2) Emit one PARENT per run, then split it into CHILDREN ──────────────
  parentRuns.forEach((blocks_, runIdx) => {
    const parentText = (headingText ? `${headingText}\n` : '') + blocks_.map((b) => b.text).join('\n\n');
    const parentId = `p-${hashText(parentText).slice(0, 16)}`;
    const pages = blocks_.map((b) => b.pageNumber).filter((p) => Number.isFinite(p));
    const parent = {
      chunkId: parentId,
      parentChunkId: null,
      chunkType: 'parent',
      documentId,
      class: cls,
      subject,
      unit,
      sourceType,
      section: headingText || null,
      headingPath: section.headingPath,
      topic: detectChunkHeading(parentText),
      sourcePage: pages.length > 0 ? Math.min(...pages) : null,
      text: parentText,
      tokenCount: countTokens(parentText),
      hash: hashText(parentText),
      runIndex: runIdx,
      chunkIndex: 0, // renumbered below
    };
    parents.push(parent);

    // ── CHILD splitting: paragraph → sentence fallback, never mid-sentence ──
    const childParts = [];
    let buf = [];
    let bufTok = 0;
    const flushBuf = () => {
      if (buf.length > 0) childParts.push({ text: buf.join('\n\n'), pages: [] });
      buf = [];
      bufTok = 0;
    };
    for (const b of blocks_) {
      const bt = countTokens(b.text);
      if (bt > maxTokens) {
        // Oversized block: split at SENTENCE boundaries with overlap.
        flushBuf();
        for (const piece of splitBySentences(b.text, maxTokens, overlapTokens)) {
          childParts.push({ text: piece, pages: [b.pageNumber] });
        }
        continue;
      }
      if (bufTok + bt > maxTokens && buf.length > 0) flushBuf();
      buf.push(b.text);
      bufTok += bt;
    }
    flushBuf();

    // Merge tiny trailing children into the previous one (coherence first).
    const merged = [];
    for (const part of childParts) {
      const t = part.text.trim();
      if (!t) continue;
      if (merged.length > 0 && countTokens(t) < Math.min(minTokens, 20)) {
        merged[merged.length - 1].text += `\n\n${t}`;
        continue;
      }
      merged.push(part);
    }

    merged.forEach((part, idx) => {
      // Give every child its section heading as context EXCEPT when the child
      // is the whole (single) content of the section — the parent already
      // carries the heading and duplication would only pollute embeddings.
      const withHeading = (headingText && merged.length > 1 && !part.text.startsWith(headingText))
        ? `${headingText}\n${part.text}`
        : part.text;
      const childId = `c-${hashText(withHeading).slice(0, 16)}`;
      children.push({
        chunkId: childId,
        parentChunkId: parentId,
        chunkType: 'child',
        documentId,
        class: cls,
        subject,
        unit,
        sourceType,
        section: headingText || null,
        headingPath: section.headingPath,
        topic: detectChunkHeading(withHeading),
        sourcePage: part.pages.filter(Number.isFinite)[0] ?? null,
        text: withHeading,
        tokenCount: countTokens(withHeading),
        hash: hashText(withHeading),
        childIndex: idx,
        chunkIndex: 0, // renumbered below
      });
    });
  });

  // Number all chunks sequentially (parents, then children) for stable ordering.
  let i = 0;
  for (const p of parents) p.chunkIndex = i++;
  for (const c of children) c.chunkIndex = i++;

  return { parents, children };
}

/**
 * Chunk a structured document (Docling output shape).
 * @param {Object} doc - { documentId, elements: [{type,text,pageNumber,headingPath}] }
 * @param {Object} scope - { class, subject, unit }
 * @param {Object} [opts] - { minTokens, maxTokens, overlapTokens }
 */
export function chunkStructuredDocument(doc, scope, opts = {}) {
  const options = {
    minTokens: opts.minTokens ?? env.CHUNK_MIN_TOKENS,
    maxTokens: opts.maxTokens ?? env.CHUNK_MAX_TOKENS,
    overlapTokens: opts.overlapTokens ?? env.CHUNK_OVERLAP_TOKENS,
  };
  const ctx = {
    documentId: doc?.documentId || 'doc',
    cls: scope.class ?? null,
    subject: scope.subject ?? null,
    unit: scope.unit ?? null,
    // PART 8: syllabus/notes corpus by construction. Reference papers never
    // flow through this chunker for academic retrieval.
    sourceType: 'syllabus_notes',
  };
  const parents = [];
  const children = [];
  for (const section of buildSections(doc?.elements || [])) {
    const out = chunkSection(section, ctx, options);
    parents.push(...out.parents);
    children.push(...out.children);
  }
  return { parents, children };
}

/**
 * Chunk legacy plain text (existing pdf-parser output) with the SAME
 * structure-aware rules. Headings are detected with the existing
 * notes-chunker heuristic so both engines produce comparable chunks.
 * @param {string} text
 * @param {Object} scope - { class, subject, unit }
 * @param {Object} [opts]
 */
export function chunkPlainText(text, scope, opts = {}) {
  const clean = String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const lines = clean.split('\n');
  const elements = [];
  let paraBuf = [];
  let headingPath = [];
  let pageNo = null;

  const flushPara = () => {
    const t = paraBuf.join(' ').replace(/\s+/g, ' ').trim();
    if (t) elements.push({ type: 'paragraph', text: t, pageNumber: pageNo, headingPath: [...headingPath] });
    paraBuf = [];
  };

  // Track pages if the text carries the legacy page markers ("[Page N]").
  const pageRe = /\[?\s*Page\s+(\d+)\s*\]?/i;

  for (const raw of lines) {
    const line = raw.trim();
    const pm = line.match(pageRe);
    if (pm) pageNo = parseInt(pm[1], 10);
    if (!line || pageRe.test(line)) continue;
    if (detectChunkHeading(line)) {
      flushPara();
      headingPath = [...headingPath, line].slice(-3);
      elements.push({ type: 'heading', text: line, pageNumber: pageNo, headingPath: headingPath.slice(0, -1) });
      continue;
    }
    if (/^[-•*]\s+/.test(line)) {
      flushPara();
      elements.push({ type: 'list_item', text: line.replace(/^[-•*]\s+/, ''), pageNumber: pageNo, headingPath: [...headingPath] });
      continue;
    }
    paraBuf.push(line);
    // Hard paragraph break on very long buffers without blank lines.
    if (countTokens(paraBuf.join(' ')) > (opts.maxTokens ?? env.CHUNK_MAX_TOKENS) * 2) flushPara();
  }
  flushPara();

  return chunkStructuredDocument({ documentId: 'legacy-' + hashText(clean).slice(0, 12), elements }, scope, opts);
}

export default { chunkStructuredDocument, chunkPlainText, countTokens, splitSentences };

