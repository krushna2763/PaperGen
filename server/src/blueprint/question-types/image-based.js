/**
 * Question type registry — IMAGE_BASED.
 */
export default {
  id: 'IMAGE_BASED',
  label: 'Image Based',
  blueprintType: 'IMAGE_BASED',
  itemsIndependent: false,
  optionBearer: false,
  optionMode: 'none',
  answerShape: 'text',
  marksMode: 'perItem',
  countKey: 'itemCount',
  countLabel: 'Items',
  countMin: 1,
  defaultInstruction: 'Study the following image and answer the questions:',
  generatorHint:
    'Questions directly reference, inspect and test understanding of the provided image.',
  fields: [
    { key: 'itemCount', label: 'Items', type: 'number', min: 1, step: 1, required: true },
  ],
};
