/**
 * Question type registry — SHORT_ANSWER.
 */
export default {
  id: 'SHORT_ANSWER',
  label: 'Short answer',
  blueprintType: 'SHORT_ANSWER',
  itemsIndependent: true,
  optionBearer: false,
  optionMode: 'none',
  marksMode: 'perItem',
  countKey: 'itemCount',
  countLabel: 'Items',
  countMin: 1,
  defaultInstruction: 'Answer the following questions:',
  generatorHint:
    'Each item is a direct question answered in a word, a phrase or 1-2 sentences.',
  fields: [
    { key: 'itemCount', label: 'Items', type: 'number', min: 1, step: 1, required: true },
  ],
};
