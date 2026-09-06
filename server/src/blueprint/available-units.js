/**
 * available-units.js
 *
 * `availableUnits` for the confirm screen is the syllabus-unit list for a
 * class + subject — the units the teacher can assign slots to.
 *
 * A UNIT is a syllabus chapter (Unit 1, Unit 2). It is what POST /kb/notes
 * tags notes with and what retrieval filters on. A SECTION (Reading, Grammar,
 * Literature) is a part of the *reference paper* — locked in the blueprint,
 * preserved in the generated paper, and never a teacher-facing choice. The two
 * are not interchangeable: a section id would never match notes indexed under
 * "Unit 1", so it would retrieve nothing and fail unitHasNotes validation.
 *
 * Units therefore come from ONE source — the notes corpus — so the behaviour
 * is identical for every subject and does not depend on the reference paper.
 * When no notes are indexed the list is empty and the client prompts for an
 * upload rather than offering a selection that cannot work.
 */

/**
 * @param {Object} args
 * @param {Array<{ id, label, chunkCount }>} args.unitsWithNotes - qdrantStore.listUnitsWithNotes output
 * @returns {Array<{ id: string, label: string, chunkCount: number }>}
 */
export function deriveAvailableUnits({ unitsWithNotes = [] } = {}) {
  return (Array.isArray(unitsWithNotes) ? unitsWithNotes : [])
    .filter((u) => u && u.id != null)
    .map((u) => ({
      id: String(u.id),
      label: u.label != null ? String(u.label) : String(u.id),
      chunkCount: Number.isFinite(Number(u.chunkCount)) ? Number(u.chunkCount) : 0,
    }));
}

export default { deriveAvailableUnits };
