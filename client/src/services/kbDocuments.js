/**
 * kbDocuments.js — pure helpers for Mode B "Select from Knowledge Base".
 *
 * The KB tab lists NOTE DOCUMENTS (one ingested notes file each), grouped from
 * the one syllabus corpus by content hash — no second Knowledge Base. These
 * helpers are pure so they can be unit-tested without React.
 */

/**
 * Scope-aware search over note documents.
 *
 * Matches title, filename, class, subject and any unit label — case- and
 * whitespace-insensitive. `scope` (the paper's class/subject) already filters
 * server-side, but the client re-checks defensively so a stale response never
 * shows a foreign document as selectable.
 *
 * @param {Array<Object>} documents - kbService.listDocuments() data
 * @param {string} query - free-text search
 * @param {Object} [scope] - { class, subject } — when both set, restricts to them
 * @returns {Array<Object>} matching documents (input order preserved)
 */
export function searchKbDocuments(documents, query, scope = {}) {
  const docs = Array.isArray(documents) ? documents : [];
  const q = String(query ?? '').trim().toLowerCase();
  const cls = String(scope.class ?? '').trim().toLowerCase();
  const subj = String(scope.subject ?? '').trim().toLowerCase();

  return docs.filter((d) => {
    if (!d) return false;
    if (cls && String(d.class ?? '').trim().toLowerCase() !== cls) return false;
    if (subj && String(d.subject ?? '').trim().toLowerCase() !== subj) return false;
    if (!q) return true;
    const unitLabels = (Array.isArray(d.units) ? d.units : []).map((u) => String(u?.label ?? ''));
    const haystack = [d.title, d.filename, d.class, d.subject, ...unitLabels]
      .map((v) => String(v ?? '').toLowerCase())
      .join(' ');
    return haystack.includes(q);
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "12 Aug 2026" from an ISO timestamp; empty string for absent/invalid input.
 * @param {string|null} iso
 * @returns {string}
 */
export function formatKbDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Merge a selected KB document's units with the session's already-indexed
 * units for the same (class, subject). The KB document's units come first and
 * win on conflicts (same id) — the selection is what this paper grounds on.
 * Unit ids stay exact strings; retrieval is unit-tagged downstream, so nothing
 * about generation changes.
 *
 * @param {Object|null} doc - selected KB document (null → session units only)
 * @param {Array<{ id, label, chunkCount }>} sessionUnits
 * @returns {Array<{ id, label, chunkCount }>}
 */
export function mergeUnitsWithSelection(doc, sessionUnits) {
  const session = Array.isArray(sessionUnits) ? sessionUnits : [];
  if (!doc || !Array.isArray(doc.units)) return session;
  const merged = doc.units
    .filter((u) => u && u.id != null && String(u.id).trim() !== '')
    .map((u) => ({ id: String(u.id), label: String(u.label ?? u.id), chunkCount: Number(u.chunkCount) || 0 }));
  const seen = new Set(merged.map((u) => u.id));
  for (const u of session) {
    if (u && u.id != null && !seen.has(String(u.id))) merged.push(u);
  }
  return merged;
}
