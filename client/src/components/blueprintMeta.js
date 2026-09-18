/**
 * blueprintMeta.js — safe, generic formatting of structured blueprint
 * metadata (construction pattern, image layout, etc.) for display. Plain JS
 * (no JSX) so it stays independently unit-testable under node --test, which
 * cannot parse JSX.
 *
 * Real bug this exists to prevent: a blueprint slot's `pattern` field is an
 * OBJECT ({ instructionType, answerForm, layout, optionCounts,
 * maxOptionCount, optionLabelStyle } — see blueprint-normalizer.js), not a
 * string. Rendering it directly as a React child (`{q.pattern}`) throws
 * "Objects are not valid as a React child" the moment a teacher expands a
 * locked/IMAGE_BASED/MIXED question row. Every caller must go through
 * formatMetaValue() instead of interpolating a blueprint field directly.
 */

/** "instructionType" -> "Instruction type" for a readable metadata label. */
export function humanizeMetaKey(key) {
  const spaced = String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Render any structured blueprint metadata (a construction/pattern object,
 * an array, a scalar, or nothing) as a single readable string — never a raw
 * object/array handed to React as a child. Objects become "Label: value"
 * pairs joined by " • "; arrays join their (recursively formatted) entries
 * with ", "; empty/null/undefined collapses to a caller-supplied fallback.
 * Generic on purpose — works for `pattern`, `imageLayout`, or any future
 * structured field, not just the one that crashed.
 * @param {*} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function formatMetaValue(value, fallback = 'Not detected') {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => formatMetaValue(v, '')).filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : fallback;
  }
  if (typeof value === 'object') {
    const parts = Object.entries(value)
      .map(([k, v]) => [k, formatMetaValue(v, '')])
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${humanizeMetaKey(k)}: ${v}`);
    return parts.length > 0 ? parts.join(' • ') : fallback;
  }
  return String(value);
}

export default { formatMetaValue, humanizeMetaKey };
