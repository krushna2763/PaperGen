/**
 * Question type registry — DIFFERENCE_BETWEEN (maps to pipeline type
 * DIFFERENTIATE, whose answer form is comparison-points).
 */
export default {
  id: 'DIFFERENCE_BETWEEN',
  label: 'Difference between',
  blueprintType: 'DIFFERENTIATE',
  itemsIndependent: true,
  optionBearer: false,
  optionMode: 'none',
  marksMode: 'perItem',
  countKey: 'itemCount',
  countLabel: 'Items',
  countMin: 1,
  defaultInstruction: 'Write the difference between the following:',
  generatorHint:
    'Each item names two things to differentiate; the answer lists point-wise differences between them.',
  fields: [
    { key: 'itemCount', label: 'Items', type: 'number', min: 1, step: 1, required: true },
  ],
};
