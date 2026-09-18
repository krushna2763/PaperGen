/**
 * Question type registry — MCQ.
 *
 * One type per module: adding a type must never touch the manual builder, the
 * blueprint validator or the generator. A definition declares everything the
 * generic code needs: ids, field constraints, itemsIndependent, marks mode and
 * a generator hint describing what a valid item looks like.
 */
export default {
  id: 'MCQ',
  label: 'Multiple choice',
  blueprintType: 'MCQ', // canonical pipeline type (BLUEPRINT_TYPES / aliases)
  itemsIndependent: true,
  optionBearer: true,
  optionMode: 'required',
  answerShape: 'option', // answer = the correct option's exact text
  marksMode: 'perItem',
  countKey: 'itemCount',
  countLabel: 'Items',
  countMin: 1,
  defaultInstruction: 'Choose the correct option:',
  generatorHint:
    'Each item is a self-contained multiple-choice stem; every item carries its own options array (one correct choice among them), never bare statements.',
  fields: [
    { key: 'itemCount', label: 'Items', type: 'number', min: 1, step: 1, required: true },
    { key: 'optionCount', label: 'Options per item', type: 'number', min: 2, max: 6, step: 1, required: true },
  ],
};
