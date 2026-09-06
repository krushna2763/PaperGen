import { geminiClient } from '../services/gemini-client.service.js';
import { parseJsonObject, normalizeQuestionText } from './agent-utils.js';

/**
 * Validation Agent (Module 11)
 *
 * Two-stage validation:
 *   1. Fast deterministic checks (pure JavaScript, no LLM) — structure,
 *      required fields, marks, type, normalized exact duplicates.
 *   2. Batch LLM quality validation — one Gemini call for ALL questions that
 *      pass the deterministic stage (academic relevance, difficulty, class,
 *      subject, completeness, grammar, meaningfulness, appropriateness).
 *
 * Batch validation turns N per-question LLM calls into 1, cutting the dominant
 * latency + rate-limit churn of the pipeline.
 */
const VALID_TYPES = ['MCQ', 'SHORT_ANSWER', 'LONG_ANSWER', 'TRUE_FALSE', 'FILL_IN_THE_BLANK'];

const BATCH_VALIDATION_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          questionId: { type: 'string' },
          valid: { type: 'boolean' },
          classMatch: { type: 'boolean' },
          subjectMatch: { type: 'boolean' },
          difficultyMatch: { type: 'boolean' },
          relevant: { type: 'boolean' },
          issues: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
        required: ['questionId', 'valid', 'issues', 'reason'],
      },
    },
  },
  required: ['results'],
};

function formatContext(context, limit = 5) {
  const slice = Array.isArray(context) ? context.slice(0, limit) : [];
  if (slice.length === 0) return '(no retrieved context available)';

  return slice
    .map((q, i) => `[${q.questionNumber || `source-${i + 1}`}] ${q.text}`)
    .join('\n');
}

function formatQuestions(questions) {
  return questions
    .map((q) => {
      const extras = [];
      if (q.passage) extras.push(`Passage: ${q.passage}`);
      if (Array.isArray(q.subParts) && q.subParts.length > 0) {
        extras.push(`Sub-parts: ${q.subParts
          .map((sp) => {
            const opts = Array.isArray(sp.options) && sp.options.length > 0
              ? ` [options: ${sp.options.join(' | ')}]`
              : '';
            return sp.text + opts;
          })
          .join(' | ')}`);
      }
      if (Array.isArray(q.options) && q.options.length > 0) {
        extras.push(`Options: ${q.options.join(' | ')}`);
      }
      if (q.columns && Array.isArray(q.columns.left) && Array.isArray(q.columns.right)) {
        extras.push(`Column A: ${q.columns.left.join(' | ')}`);
        extras.push(`Column B: ${q.columns.right.join(' | ')}`);
      }
      if (Array.isArray(q.choices) && q.choices.length > 0) {
        extras.push(`Internal choices (OR branches): ${q.choices
          .map((c) => c.text + (Array.isArray(c.subParts) && c.subParts.length ? ` [${c.subParts.join(' | ')}]` : ''))
          .join('  OR  ')}`);
      }
      return `[ID: ${q.questionId}] Text: ${q.text} | Type: ${q.type} | Marks (total): ${q.marks} | Claimed difficulty: ${q.difficulty}${extras.length > 0 ? '\n  ' + extras.join('\n  ') : ''}`;
    })
    .join('\n');
}

const CHECKLIST = `EVALUATION CHECKLIST (mark each per question):
1. classMatch — appropriate for the stated class level?
2. subjectMatch — within the stated subject?
3. difficultyMatch — does the actual question match the REQUESTED difficulty (not the claimed one)? Easy = direct recall; Medium = conceptual understanding + moderate reasoning; Difficult = multi-step reasoning/analysis.
4. relevant — based on concepts from the retrieved context / topic, not invented content?
5. Completeness — complete, makes sense independently, has a clear expected answer?
6. Grammar & clarity — no ambiguous or awkward wording?
7. Academic appropriateness — school-appropriate, meaningful, correctly formed?

Rules:
- If ANY checklist item clearly fails for a question, set its "valid" to false and list the issue(s).
- Do not penalize for being a NEW scenario — new scenarios are desired.
- "valid" must be true only when the question fully passes.`;

export const validationAgent = {
  /**
   * Fast deterministic checks (pure JavaScript, no LLM).
   * @param {Object} question - { questionId, text, type, marks, difficulty }
   * @param {Object} [opts]
   *   - compareTexts: string[] raw texts to check normalized exact duplicates against
   *   - validTypes: string[] allowed types (blueprint mode widens the set)
   *   - useFullText: compare duplicates on fullText (passage+parts) instead of the bare stem
   * @returns {{ ok: boolean, reasons: string[] }}
   */
  deterministicCheck(question, opts = {}) {
    const { compareTexts = [], validTypes = VALID_TYPES, useFullText = false, blueprint = null, slotIndex = null } = opts;
    const text = String(question?.text || '').trim();
    const dupText = useFullText ? String(question?.fullText || question?.text || '').trim() : text;
    const reasons = [];

    if (!text || text.length < 5) {
      reasons.push('Question text is empty or too short.');
    }
    if (/\b(?:undefined|null)\b|\[object Object\]/i.test(text)) {
      reasons.push('Question text contains placeholder artifacts (undefined/null/[object Object]).');
    }
    // MARKS: blueprint marks are authoritative (blueprint-validator skips the
    // check when the reference marks are unknown). The deterministic gate must
    // agree, otherwise a reference slot whose printed marks could not be
    // parsed (e.g. a "Match the following" block without a marks column)
    // becomes ungeneratable — the generator faithfully emits no marks and this
    // check rejects it forever (deadlock observed live: 0/5 accepted).
    const slotMarksKnown = (() => {
      if (slotIndex == null || !blueprint || !Array.isArray(blueprint.questions)) return true;
      const slot = blueprint.questions[slotIndex];
      return slot == null || slot.totalMarks != null;
    })();
    if (slotMarksKnown && !(Number.isFinite(question?.marks) && question.marks > 0)) {
      reasons.push(`Invalid or missing marks value: ${question?.marks ?? '(none)'}.`);
    }
    if (!validTypes.includes(question?.type)) {
      reasons.push(`Invalid question type: ${question?.type || '(missing)'}.`);
    }
    if (!question?.difficulty) {
      reasons.push('Missing difficulty field.');
    }

    const norm = normalizeQuestionText(dupText);
    if (norm && compareTexts.some(t => normalizeQuestionText(t) === norm && String(t) !== dupText)) {
      reasons.push('Exact duplicate of another question (after normalization).');
    }

    return { ok: reasons.length === 0, reasons };
  },

  /**
   * Cheap deterministic pre-checks (legacy single-question entry).
   * Returns an invalid result object or null when pre-checks pass.
   * @param {Object} question
   * @returns {Object|null}
   */
  preCheck(question) {
    const result = this.deterministicCheck(question);
    if (result.ok) return null;
    return {
      valid: false,
      reason: result.reasons.join('; '),
      issues: result.reasons,
      classMatch: null,
      subjectMatch: null,
      difficultyMatch: null,
      relevant: null,
    };
  },

  /**
   * LLM quality validation of a single generated question.
   * @param {Object} question - { questionId, text, type, marks, difficulty }
   * @param {Object} requirements - { class, subject, topic?, difficulty, questionType? }
   * @param {Array<Object>} context - Retrieved source questions
   * @returns {Promise<{ valid, reason, issues, classMatch, subjectMatch, difficultyMatch, relevant }>}
   */
  async validate(question, requirements, context) {
    const [result] = await this.validateBatch([question], requirements, context);
    return result;
  },

  /**
   * Batch LLM validation — ONE Gemini call for all questions.
   * Deterministic failures are short-circuited locally; only structurally
   * valid questions reach the LLM.
   *
   * @param {Array<Object>} questions - { questionId, text, type, marks, difficulty }
   * @param {Object} requirements - { class, subject, topic?, difficulty, questionType? }
   * @param {Array<Object>} context - Retrieved source questions
   * @returns {Promise<Array<{ questionId, valid, reason, issues, classMatch, subjectMatch, difficultyMatch, relevant }>>}
   */
  async validateBatch(questions, requirements, context) {
    const results = [];
    const llmInput = [];
    const blueprint = requirements?.blueprint || null;
    // Blueprint mode widens the accepted type set to the blueprint's own types.
    const validTypes = blueprint
      ? [...new Set([...VALID_TYPES, ...blueprint.questions.map((q) => q.type)])]
      : VALID_TYPES;

    for (const question of questions) {
      const local = this.deterministicCheck(question, { validTypes, blueprint, slotIndex: question?.slotIndex ?? null });
      if (local.ok) {
        llmInput.push(question);
      } else {
        results.push({
          questionId: question.questionId,
          valid: false,
          reason: local.reasons.join('; '),
          issues: local.reasons,
          classMatch: null,
          subjectMatch: null,
          difficultyMatch: null,
          relevant: null,
        });
      }
    }

    if (llmInput.length > 0) {
      const blueprintBlock = blueprint
        ? `
LOCKED BLUEPRINT SLOT EXPECTATIONS (structure is enforced deterministically; judge CONTENT only):
${llmInput
          .map((q) => {
            const slot = q.slotIndex != null ? blueprint.questions[q.slotIndex] : null;
            if (!slot) return null;
            const rule = slot.optionalRule ? `, optionalRule=any ${slot.optionalRule.n}` : '';
            const pat = slot.pattern && typeof slot.pattern === 'object' ? slot.pattern : {};
            const patBits = [
              pat.answerForm ? `answerForm=${pat.answerForm}` : null,
              pat.instructionType ? `construction=${pat.instructionType}` : null,
              Number.isFinite(Number(pat.maxOptionCount)) ? `perItemOptions=${Math.round(Number(pat.maxOptionCount))}` : null,
            ].filter(Boolean);
            const itemRefs = (Array.isArray(slot.items) && slot.items.length > 0 ? slot.items : [])
              .filter((it) => it?.referenceText)
              .slice(0, 6);
            const anchors = itemRefs.length > 0
              ? itemRefs.map((it, ix) => `- part ${String.fromCharCode(97 + (ix % 26))}: ${String(it.referenceText).slice(0, 150)}${it.marks != null ? ` (${it.marks} mark${it.marks === 1 ? '' : 's'})` : ''}`).join('\n      ')
              : ((Array.isArray(slot.referenceItems) && slot.referenceItems.length > 0)
                  ? slot.referenceItems.slice(0, 2).map((r) => `- ${String(r).slice(0, 180)}`).join('\n      ')
                  : null);
            return `[ID: ${q.questionId}] expected slot ${q.slotIndex + 1} (${slot.label}): type=${slot.type}, totalMarks=${slot.totalMarks}, items=${slot.itemCount}${rule}${patBits.length ? ', ' + patBits.join(', ') : ''}\n      Reference items IN ORDER — each NEW sub-part must stay on the SAME concept as its positional counterpart (sub-part a ↔ item a, b ↔ b, …) with the same per-part marks; never swap, drop or merge concepts; new wording/scenario is expected:\n      ${anchors || '(no reference items available)'}`;
          })
          .filter(Boolean)
          .join('\n')}
The slot's TYPE, MARKS, ITEM COUNT, OPTION COUNT and PASSAGE presence are enforced deterministically by a separate blueprint validator — do NOT mark a question invalid for those here. Only judge CONTENT: (a) topicMatch — same educational concept area as the slot's reference topic anchors (never fail for a new scenario or new wording); (b) content-format consistency with the slot type (an MCQ slot must contain choice items, a passage slot must ask about its own passage); (c) relevance, difficulty, completeness, grammar, appropriateness.
`
        : '';

      const checklist = blueprint
        ? `${CHECKLIST}
8. topicMatch — stays in the SAME concept area as the slot's reference topic anchors? Same topic + new wording/scenario is exactly what is wanted; drifting to an unrelated topic is the failure case. For grouped questions check EACH sub-part against its OWN positional anchor (the anchors are listed in the same order as the sub-parts).
9. blueprintMatch — content only: is the question's CONTENT consistent with its expected slot type/answer form (e.g. an MCQ slot should actually contain multiple-choice items each with options and one correct choice; a TRUE_FALSE slot plain statements without options; a FILL_IN_THE_BLANK slot sentences with a blank)? Never fail on item counts or marks here — those are checked deterministically.`
        : CHECKLIST;

      const prompt = `You are a strict question quality validator for school examinations.

Evaluate EACH GENERATED question below against the requirements and retrieved context.

REQUIREMENTS:
- Class: ${requirements.class}
- Subject: ${requirements.subject}
- Topic: ${requirements.topic || 'general (concepts from retrieved context)'}
- Requested difficulty: ${requirements.difficulty}
- Requested question type: ${requirements.questionType || 'any appropriate'}

GENERATED QUESTIONS (evaluate each one individually by its questionId):
${formatQuestions(llmInput)}
${blueprintBlock}
RETRIEVED CONTEXT (concepts the questions should be based on):
${formatContext(context)}

${checklist}

OUTPUT FORMAT: Respond with ONLY a JSON object (no prose) containing one result per questionId:
{ "results": [ { "questionId": "...", "valid": true|false, "classMatch": true|false, "subjectMatch": true|false, "difficultyMatch": true|false, "relevant": true|false, "issues": ["..."], "reason": "one-line summary" } ] }`;

      const rawText = await geminiClient.generateContent(prompt, {
        responseMimeType: 'application/json',
        responseSchema: BATCH_VALIDATION_SCHEMA,
        temperature: 0.2,
      });

      const parsed = parseJsonObject(rawText);
      const rawResults = Array.isArray(parsed?.results) ? parsed.results : [];
      const byId = new Map(rawResults.map(r => [r.questionId, r]));
      const hadAnyResults = rawResults.length > 0;

      for (const question of llmInput) {
        const r = byId.get(question.questionId);
        if (!r) {
          if (hadAnyResults) {
            // Partial/truncated LLM response: some questions got a verdict but
            // this one did not. Deterministic + similarity gates already passed,
            // so accept with a warning instead of burning a regeneration round.
            results.push({
              questionId: question.questionId,
              valid: true,
              reason: 'No LLM validation result returned (truncated response); accepted on deterministic checks.',
              issues: [],
              classMatch: null,
              subjectMatch: null,
              difficultyMatch: null,
              relevant: null,
            });
          } else {
            results.push({
              questionId: question.questionId,
              valid: false,
              reason: 'No validation result returned for this question.',
              issues: ['No validation result returned.'],
              classMatch: null,
              subjectMatch: null,
              difficultyMatch: null,
              relevant: null,
            });
          }
          continue;
        }
        const valid = r.valid === true;
        const issues = Array.isArray(r.issues) ? r.issues.filter(i => typeof i === 'string') : [];
        const reason = typeof r.reason === 'string' && r.reason.trim()
          ? r.reason.trim()
          : issues.length > 0 ? issues.join('; ') : valid ? 'Passed validation.' : 'Failed validation.';
        results.push({
          questionId: question.questionId,
          valid,
          reason,
          issues,
          classMatch: r.classMatch ?? null,
          subjectMatch: r.subjectMatch ?? null,
          difficultyMatch: r.difficultyMatch ?? null,
          relevant: r.relevant ?? null,
        });
      }
    }

    return results;
  },
};

export default validationAgent;