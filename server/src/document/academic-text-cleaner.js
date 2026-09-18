/**
 * academic-text-cleaner.js — GENERIC, deterministic OCR-diagram-noise removal
 * for reference-item SEMANTIC text (topic anchoring, concept extraction,
 * planner target resolution, novelty comparison). It never touches the
 * source PDF/image and never invents or removes legitimate academic
 * vocabulary — only structurally noise-shaped tokens (bare stray glyphs,
 * pure punctuation, repeated-character spam, short non-word fragments with
 * no recognizable role) are stripped, regardless of subject.
 *
 * Reuses the EXISTING marks/CO/BL/PO/PS/BT/K stripper (item-dependency.js)
 * as a first pass, so OCR metadata never becomes an academic concept either
 * — this module only adds a second, glyph-level pass on top of it.
 *
 * A diagram rendered on the same page as a question stem is often OCR'd as
 * body text interleaved with the real question wording (Tesseract full-page
 * segmentation reading box borders / labels as stray characters). The result
 * is contamination like "Ly | Virtual Machines } Storage ! Database ] eee t
 * ; 1 ' Identify the cloud service model..." — real diagram vocabulary
 * ("Virtual Machines", "Storage", "Database") sits beside pure noise glyphs
 * ("|", "}", "!", "]", "eee", "t", "'"). This cleaner removes the glyphs
 * while leaving every real word — including short technical acronyms like
 * "SaaS"/"PaaS"/"IaaS"/"OS"/"VM" — untouched.
 */
import { cleanAcademicText } from '../planner/item-dependency.js';

/** Universal English function words a real sentence may carry standalone (never subject vocabulary). */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'as', 'at', 'be', 'by', 'if', 'in', 'is', 'it', 'of', 'on', 'or', 'so', 'to', 'up',
  'us', 'we', 'he', 'she', 'the', 'and', 'for', 'are', 'was', 'not', 'you', 'but', 'all', 'can',
  'has', 'had', 'out', 'who', 'how', 'why', 'use', 'via',
]);

/** A token with no letters/digits at all — pure punctuation/symbol glyphs. */
function isPureSymbolToken(tok) {
  return !/[a-zA-Z0-9]/.test(tok);
}

/** The whole token is one character repeated 3+ times ("eee", "aaa") — OCR spam, never a real word. */
function isRepeatedCharSpam(tok) {
  return /^(.)\1{2,}$/i.test(tok);
}

/**
 * A token carrying parenthesis punctuation is a structural list/option
 * marker ("i)", "(a)", "ii)") and is never treated as noise, regardless of
 * how short its bare letters are.
 */
function isListMarkerShaped(tok) {
  return /[()]/.test(tok);
}

/** A single bare letter standing alone is never real prose except the article "a" or the pronoun "A"/"I". */
function isBareLetterNoise(tok) {
  if (isListMarkerShaped(tok)) return false;
  if (tok === 'a' || tok === 'A' || tok === 'I') return false;
  return /^[a-zA-Z]$/.test(tok);
}

/**
 * A 2-3 letter alphabetic fragment that is neither a recognized function
 * word nor shaped like an ALL-CAPS acronym (OS, IT, VM, API…) is treated as
 * OCR noise. Real short-form academic abbreviations are conventionally
 * all-uppercase, so this never removes a genuine subject acronym while still
 * catching stray fragments such as "Ly" / "t".
 */
function isShortNoiseWord(tok) {
  if (isListMarkerShaped(tok)) return false;
  const bare = tok.replace(/[^a-zA-Z]/g, '');
  if (bare.length === 0 || bare.length > 3) return false;
  if (FUNCTION_WORDS.has(bare.toLowerCase())) return false;
  if (bare.length >= 2 && bare === bare.toUpperCase()) return false; // acronym shape, keep
  return true;
}

/**
 * Clean raw (possibly OCR-contaminated) reference-item text into text
 * suitable for semantic analysis (topic anchoring, concept extraction,
 * planner target resolution, novelty comparison). The caller should keep the
 * original text separately (e.g. as `rawReferenceText`) for provenance —
 * this function never mutates or discards it.
 *
 * Fail-safe: if every token happens to look noise-shaped (a very short,
 * heavily-garbled fragment), the marks-cleaned text is returned unchanged
 * rather than losing the item's content entirely.
 */
export function cleanAcademicSemanticText(rawText) {
  const marksClean = cleanAcademicText(rawText);
  if (!marksClean) return '';
  const words = marksClean.split(/\s+/).filter(Boolean);
  const kept = words.filter((w) =>
    !isPureSymbolToken(w) && !isRepeatedCharSpam(w) && !isBareLetterNoise(w) && !isShortNoiseWord(w));
  if (kept.length === 0) return marksClean;
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

export default { cleanAcademicSemanticText };
