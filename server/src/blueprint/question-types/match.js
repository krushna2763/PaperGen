/**
 * Question type registry — MATCH (pipeline type MATCH_THE_FOLLOWING).
 *
 * Shape decision (approved): mirrors the extractor's MATCH emission —
 * items: [], itemCount = pairCount, whole-question marks and unit assignment.
 * No per-item structure is invented, so validator §3/§6d and the whole-question
 * slotUnitMap form work unchanged on both paths.
 */
export default {
  id: 'MATCH',
  label: 'Match the following',
  blueprintType: 'MATCH_THE_FOLLOWING',
  itemsIndependent: true, // pairs are independent; a shared stimulus would make this false
  optionBearer: false,
  optionMode: 'none',
  answerShape: 'pairs',
  marksMode: 'whole', // whole-question marks, like the reference path's MATCH slots
  countKey: 'itemCount',
  countLabel: 'Pairs',
  countMin: 2,
  defaultInstruction: 'Match the following columns:',
  generatorHint:
    'Output the two equal-length match columns (columns.left / columns.right) with one correct pairing per row; each pair tests the stated topic.',
  fields: [
    { key: 'itemCount', label: 'Pairs', type: 'number', min: 2, step: 1, required: true },
  ],
};
