/**
 * Question type registry — LONG_ANSWER.
 */
export default {
  id: 'LONG_ANSWER',
  label: 'Long answer',
  blueprintType: 'LONG_ANSWER',
  itemsIndependent: true,
  optionBearer: false,
  optionMode: 'none',
  answerShape: 'text',
  marksMode: 'perItem',
  countKey: 'itemCount',
  countLabel: 'Items',
  countMin: 1,
  defaultInstruction: 'Answer the following questions in detail:',
  generatorHint:
    'Each item needs an extended response — a paragraph with reasoning or multiple points; 4+ marks per item is typical.',
  fields: [
    { key: 'itemCount', label: 'Items', type: 'number', min: 1, step: 1, required: true },
  ],
};
