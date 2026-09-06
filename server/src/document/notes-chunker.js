/**
 * notes-chunker.js
 *
 * Deterministic chunking of syllabus notes into retrieval units. Splits on
 * chapter / heading boundaries, never mid-concept:
 *
 *   - a heading line starts a new chunk (once the current chunk has real body)
 *   - an over-long chunk is split on blank lines, never inside a sentence
 *   - tiny trailing fragments merge back into the previous chunk
 *
 * No LLM, no TOC parsing. The unit tag is supplied explicitly by the teacher
 * and is NOT inferred here (see kb.controller.js).
 */

const MAX_CHARS = 1200;
const MIN_CHARS = 200;

// A heading: "Chapter 3", "Lesson 2", "Unit 4", "3.1 Photosynthesis",
// "TOPIC:", or an ALL-CAPS title line. Kept intentionally conservative.
const HEADING_RE = new RegExp(
  [
    /^(chapter|lesson|unit|section|topic)\b[\s:.-]*\d*.{0,80}$/i.source,
    /^\d+(\.\d+)*\s+[A-Z].{0,80}$/.source,
    /^[A-Z][A-Z0-9 .,'()/-]{6,80}$/.source,
  ].join('|')
);

const isHeading = (line) => HEADING_RE.test(String(line || '').trim());

/**
 * @param {string} text - cleaned notes text (already OCR-merged upstream)
 * @returns {Array<{ text: string, chunkIndex: number }>}
 */
export function chunkNotes(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];

  // 1) Break on headings.
  const blocks = [];
  let cur = [];
  const bodyLen = () => cur.join('').replace(/\s/g, '').length;
  const flush = () => {
    const t = cur.join('\n').trim();
    if (t) blocks.push(t);
    cur = [];
  };
  for (const line of clean.split('\n')) {
    if (isHeading(line) && bodyLen() >= MIN_CHARS) flush();
    cur.push(line);
  }
  flush();

  // 2) Split over-long blocks on blank lines (paragraph boundaries).
  const split = [];
  for (const b of blocks) {
    if (b.length <= MAX_CHARS) {
      split.push(b);
      continue;
    }
    let buf = '';
    for (const para of b.split(/\n\s*\n/)) {
      if (buf && buf.length + para.length + 2 > MAX_CHARS) {
        split.push(buf.trim());
        buf = '';
      }
      buf += (buf ? '\n\n' : '') + para;
    }
    if (buf.trim()) split.push(buf.trim());
  }

  // 3) Merge tiny fragments into the previous chunk.
  const merged = [];
  for (const c of split) {
    if (merged.length > 0 && c.length < MIN_CHARS) merged[merged.length - 1] += '\n\n' + c;
    else merged.push(c);
  }

  return merged.map((chunkText, chunkIndex) => ({ text: chunkText, chunkIndex }));
}

export default { chunkNotes };
