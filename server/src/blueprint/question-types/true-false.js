/**
 * Question type registry — TRUE_FALSE.
 * Options are FORBIDDEN: the blueprint validator rejects option lists on
 * TRUE_FALSE items, so the registry encodes that constraint up front.
 */
export default {
  id: 'TRUE_FALSE',
  label: 'True / False',
  blueprintType: 'TRUE_FALSE',
  itemsIndependent: true,
  optionBearer: false,
  optionMode: 'none',
  answerShape: 'boolean',
  marksMode: 'perItem',
  countKey: 'itemCount',
  countLabel: 'Statements',
  countMin: 1,
  defaultInstruction: 'State whether true or false:',
  generatorHint:
    'Each item is a plain statement the student marks true or false — never option lists, never blanks.',
  fields: [
    { key: 'itemCount', label: 'Statements', type: 'number', min: 1, step: 1, required: true },
  ],
};
