/**
 * questionTypeLabel — one place that turns a raw blueprint/generated question
 * type (MCQ, FILL_IN_THE_BLANK, …) into a human label. Used by the Mode A
 * generate screen and the Mode A review screen so both name types the same way.
 * Presentation only — never fed back into the pipeline.
 */
const TYPE_LABELS = {
  MCQ: 'Multiple Choice (MCQ)',
  MULTIPLE_CHOICE: 'Multiple Choice (MCQ)',
  TRUE_FALSE: 'True / False',
  FILL_IN_THE_BLANK: 'Fill in the Blanks',
  FILL_IN_THE_BLANKS: 'Fill in the Blanks',
  SHORT_ANSWER: 'Short Answer',
  LONG_ANSWER: 'Long Answer',
  MATCH_THE_FOLLOWING: 'Match the Following',
  MATCH: 'Match the Following',
  DIFFERENTIATE: 'Difference Between',
  DIFFERENCE_BETWEEN: 'Difference Between',
  DEFINITION: 'Definition',
  DEFINE: 'Definition',
  PASSAGE: 'Passage Based',
  PASSAGE_BASED: 'Passage Based',
  CASE_BASED: 'Case Based',
  COMPREHENSION: 'Comprehension',
  ASSERTION_REASON: 'Assertion & Reason',
  IMAGE_BASED: 'Image Based',
  MIXED: 'Mixed',
  UNKNOWN: 'Question',
};

export function questionTypeLabel(t) {
  const key = String(t || '').toUpperCase();
  if (TYPE_LABELS[key]) return TYPE_LABELS[key];
  return String(t || 'Question')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default { questionTypeLabel };
