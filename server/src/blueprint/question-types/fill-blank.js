/**
 * Question type registry — FILL_BLANK (maps to pipeline type FILL_IN_THE_BLANK).
 */
export default {
  id: 'FILL_BLANK',
  label: 'Fill in the blanks',
  blueprintType: 'FILL_IN_THE_BLANK',
  itemsIndependent: true,
  optionBearer: true,
  optionMode: 'optional', // a word bank may be offered, but blanks stand alone fine
  marksMode: 'perItem',
  countKey: 'itemCount',
  countLabel: 'Items',
  countMin: 1,
  defaultInstruction: 'Fill in the blanks:',
  generatorHint:
    'Each item is a sentence with a blank (____) to complete; optionally a shared word bank may be provided in the stem.',
  fields: [
    { key: 'itemCount', label: 'Items', type: 'number', min: 1, step: 1, required: true },
    { key: 'optionCount', label: 'Word-bank size (optional)', type: 'number', min: 2, max: 12, step: 1, required: false },
  ],
};
